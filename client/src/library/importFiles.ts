import { libraryPlace } from './libraryFolder';
import { createItem, LOCAL_USER, type Cover, type FileRef, type Item, type LibraryBackend, type Operation } from '@nexlibris/common';
import { hasIsbn, normalizeIsbn } from '../isbn/isbn';
import { CONVERTERS } from '@nexlibris/tools/formats/convert/converters';
import { epubMetadataChanges } from '@nexlibris/tools/formats/epubMetadata';
import { EPUB_FORMATS, formatFromName, isEpub, KINDLE_FORMATS, READER_EPUBS, type FormatId, type ParsedItem } from '@nexlibris/tools/formats/formats';
import { fileMetadata, metadataKey } from './fileMetadata';
import { parseOpf, type OpfMetadata } from '@nexlibris/tools/formats/opf';
import { parseFile } from '@nexlibris/tools/formats/parseFile';
import { runConversion } from './convert';
import { coverColor } from '@nexlibris/tools/coverColor';

export interface ImportResult {
  added: Item[];
  /** Books already in the library that the import added files to, with the files' names. */
  merged: { item: Item; names: string[] }[];
  skipped: { name: string; reason: string }[];
  /** Imported, but with something to report (e.g. a failed automatic conversion). */
  warnings: { name: string; message: string }[];
  /** Stopped before the end (see {@link ImportOptions.signal}); what was imported is kept. */
  stopped?: boolean;
}

export interface ImportOptions {
  /**
   * Called as each book (a group of files) is started, with the name of its first file, and once
   * it's done, whether added, merged or skipped. Counts are of books, since a Calibre library has
   * several files per book that take no time (its metadata and cover).
   */
  onProgress?(done: number, total: number, current?: string): void;
  /** Stops the import before the next book; the books already imported are saved. */
  signal?: AbortSignal;
  /** Called each time a batch of items has been saved to the library, so they can be shown before the import ends. */
  onSaved?(): void;
}

/** The reason given for skipping a file the library already has; reports count these rather than list them. */
export const ALREADY_IN_LIBRARY = 'already in the library';

const kindleToEpub = CONVERTERS.find((c) => c.id === 'kindle-epub')!;

/** Which format's metadata and cover an item takes, best first. Device-optimized copies come last. */
export const METADATA_PREFERENCE: FormatId[] = ['epub', 'azw3', 'mobi', 'azw', 'pdf', 'cbz', 'cbr', 'rtf', 'txt', ...READER_EPUBS];

/** Items are saved this many at a time, so a long import keeps what it has done if it stops partway. */
const COMMIT_EVERY = 20;

/**
 * A file to import: a picked `File`, or one the native app has already stored (see
 * `common/src/importApi.ts`), read when its turn comes.
 */
export interface ImportSource {
  name: string;
  /** With the folders it was in, when a folder was imported: `Library/Frank Herbert/Dune (12)/Dune.epub`. */
  webkitRelativePath?: string;
  type?: string;
  arrayBuffer(): Promise<ArrayBuffer>;
  /** Set if it's already in library storage, so it isn't stored again. */
  stored?: { hash: string; size: number };
}

interface Candidate {
  file: File;
  format: FormatId;
}

interface Picked {
  file: ImportSource;
  format: FormatId;
}

/** Files beside a Calibre book's formats, in its own folder: its metadata, and the cover shown in Calibre. */
interface Sidecars {
  opf?: ImportSource;
  cover?: ImportSource;
}

const pathOf = (file: ImportSource) => file.webkitRelativePath || file.name;
const folderOf = (path: string) => path.slice(0, Math.max(0, path.lastIndexOf('/'))).toLowerCase();

const COVER_TYPES: Record<string, Cover['mediaType']> = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png' };
const coverType = (name: string) => COVER_TYPES[/^cover\.([a-z]+)$/i.exec(name)?.[1]?.toLowerCase() ?? ''];

/**
 * Files in an imported folder that aren't books and aren't worth a mention: hidden files and
 * folders (Calibre's `.caltrash`, `.DS_Store`), and Calibre's and the system's own files.
 */
const IGNORED = new Set(['metadata.db', 'metadata_db_prefs_backup.json', 'full-text-search.db', 'thumbs.db', 'desktop.ini']);
export const quietlySkipped = (path: string) =>
  path.split('/').some((part) => part.startsWith('.')) || IGNORED.has(path.split('/').pop()!.toLowerCase());

/** Names a native folder pick should return besides books: the sidecars {@link importFiles} reads. */
export const SIDECAR_NAMES = ['metadata.opf', ...Object.keys(COVER_TYPES).map((e) => `cover.${e}`)];

/**
 * Which files are one book. In a Calibre library each book has its own folder, with a
 * `metadata.opf`: every format there is that book, whatever it's named. Elsewhere, a book's
 * files share a name apart from the format extension (as most exports name them):
 * `dune.epub`, `dune.mobi` and `dune.x4.epub` are one item, and same-named files in
 * different folders stay apart.
 */
function bookKey({ file, format }: Picked, calibreFolders: Set<string>) {
  const path = pathOf(file);
  const folder = folderOf(path);
  if (calibreFolders.has(folder)) return `${folder}/`;
  return path.slice(0, path.length - format.length - 1).toLowerCase();
}

/**
 * Imports files as new items, one per book: files whose names differ only in
 * format, or that share a Calibre book folder, become one item with several
 * files, and a book already in the library gets the formats it lacks. Files
 * already in the library are skipped.
 */
export async function importFiles(
  backend: LibraryBackend,
  files: ImportSource[],
  { onProgress, onSaved, signal }: ImportOptions = {},
): Promise<ImportResult> {
  const library = await backend.getLibrary();
  const knownHashes = new Set(Object.values(library.items).flatMap((item) => item.files.map((f) => f.hash)));
  const result: ImportResult = { added: [], merged: [], skipped: [], warnings: [] };
  // Items an imported book can join: the library's, and those this import adds.
  const known: Item[] = Object.values(library.items);

  // Calibre's sidecars, by folder; they're read with their book rather than imported.
  const sidecars = new Map<string, Sidecars>();
  const books = new Map<string, Picked[]>();
  const rest: ImportSource[] = [];
  for (const file of files) {
    const path = pathOf(file);
    const inFolder = path.includes('/');
    if (inFolder && (file.name.toLowerCase() === 'metadata.opf' || coverType(file.name))) {
      const folder = folderOf(path);
      const found = sidecars.get(folder) ?? {};
      if (file.name.toLowerCase() === 'metadata.opf') found.opf = file;
      else found.cover ??= file;
      sidecars.set(folder, found);
    } else if (!(inFolder && quietlySkipped(path))) rest.push(file);
  }
  const calibreFolders = new Set([...sidecars].filter(([, s]) => s.opf).map(([folder]) => folder));
  for (const file of rest) {
    const format = formatFromName(file.name);
    if (!format) {
      result.skipped.push({ name: file.name, reason: 'unsupported file type' });
      continue;
    }
    const picked = { file, format };
    const key = bookKey(picked, calibreFolders);
    books.set(key, [...(books.get(key) ?? []), picked]);
  }

  let ops: Operation[] = [];
  const commit = async () => {
    if (!ops.length) return;
    await backend.apply(ops);
    ops = [];
    onSaved?.();
  };

  let done = 0;
  for (const [key, candidates] of books) {
    if (signal?.aborted) {
      result.stopped = true;
      break;
    }
    onProgress?.(done, books.size, candidates[0]!.file.name);
    const book = key.endsWith('/') ? sidecars.get(key.slice(0, -1)) : undefined;
    const imported = await importBook(backend, candidates, book, knownHashes, known, result);
    onProgress?.(++done, books.size);
    if (!imported) continue;
    if (imported.existing) {
      const { existing, item } = imported;
      const added = item.files.filter((f) => !existing.files.some((e) => e.hash === f.hash));
      ops.push(...added.map((file): Operation => ({ type: 'attachFile', id: existing.id, file })));
      if (!existing.cover && item.cover) {
        ops.push({ type: 'updateItem', id: existing.id, patch: { cover: item.cover } });
        const color = item.metadata.coverColor;
        if (color && !existing.metadata.coverColor) ops.push({ type: 'setMetadata', id: existing.id, key: 'coverColor', value: color });
      }
      const merged = { ...existing, files: [...existing.files, ...added], cover: existing.cover ?? item.cover };
      known[known.indexOf(existing)] = merged;
      const earlier = result.merged.find((m) => m.item.id === existing.id);
      const names = added.map((f) => f.name ?? f.format);
      if (earlier) earlier.names.push(...names);
      else result.merged.push({ item: merged, names });
    } else {
      ops.push({ type: 'addItem', item: imported.item });
      if (imported.rating !== undefined) ops.push({ type: 'setRating', userId: LOCAL_USER, itemId: imported.item.id, rating: imported.rating });
      result.added.push(imported.item);
      known.push(imported.item);
    }
    if (ops.length >= COMMIT_EVERY) await commit();
  }
  await commit();
  return result;
}

/**
 * One book's files as a new item, or as files for an item already in the library (`existing`);
 * undefined if none of them could be added. A Calibre book's `metadata.opf` and cover, when it
 * has them, are its metadata and cover rather than its files'.
 */
async function importBook(
  backend: LibraryBackend,
  candidates: Picked[],
  sidecars: Sidecars | undefined,
  knownHashes: Set<string>,
  known: Item[],
  result: ImportResult,
): Promise<{ item: Item; existing?: Item; rating?: number } | undefined> {
  const rank = (c: Picked) => METADATA_PREFERENCE.indexOf(c.format);
  const stored: { candidate: Candidate; ref: FileRef }[] = [];
  for (const picked of [...candidates].sort((a, b) => rank(a) - rank(b))) {
    const { format } = picked;
    try {
      // Read the file once, since it's hashed, stored and parsed. Files the native app picked are already stored.
      const file = new File([await picked.file.arrayBuffer()], picked.file.name, { type: picked.file.type ?? '' });
      const candidate = { file, format };
      // Stored by the native app in its own library, which isn't the account's when the library's there: sent on.
      const already = libraryPlace().kind === 'cloud' ? undefined : picked.file.stored;
      const { hash, size } = already ?? (await backend.putFile(file));
      if (knownHashes.has(hash)) {
        result.skipped.push({ name: file.name, reason: ALREADY_IN_LIBRARY });
        continue;
      }
      knownHashes.add(hash);
      stored.push({ candidate, ref: { hash, size, format, name: file.name } });
    } catch (e) {
      result.skipped.push({ name: picked.file.name, reason: errorMessage(e) });
    }
  }

  // Metadata comes from the best file that parses; the cover from the best one that has a cover.
  const files: FileRef[] = [];
  /** What each EPUB read says, to tell whether it says what the item will (`fileMetadata.ts`). */
  const said = new Map<FileRef, ParsedItem>();
  let parsed: ParsedItem | undefined;
  let cover: ParsedItem['cover'];
  for (const { candidate, ref } of stored) {
    const needed = !parsed || !cover;
    let fileParsed: ParsedItem | undefined;
    if (needed) {
      try {
        fileParsed = await parseFile(candidate.format, candidate.file, candidate.file.name);
      } catch (e) {
        // Can't be read, so it isn't kept, even if another format of the book can be.
        knownHashes.delete(ref.hash);
        result.skipped.push({ name: candidate.file.name, reason: errorMessage(e) });
        continue;
      }
    }
    files.push(ref);
    if (fileParsed && isEpub(ref.format)) said.set(ref, fileParsed);
    parsed ??= fileParsed;
    cover ??= fileParsed?.cover;
  }
  if (!parsed) return undefined;

  const calibre = sidecars && (await readSidecars(sidecars, result));
  if (calibre?.opf) {
    // Calibre's metadata wins; the file's fills what Calibre doesn't have.
    const { parsed: opf } = calibre.opf;
    parsed = {
      ...opf,
      creators: opf.creators.length ? opf.creators : parsed.creators,
      identifiers: { ...parsed.identifiers, ...opf.identifiers },
      metadata: { ...parsed.metadata, ...opf.metadata },
    };
  }
  cover = calibre?.cover ?? cover;

  const existing = sameBook(known, parsed, files);
  const item = createItem(
    {
      title: parsed.title,
      creators: parsed.creators,
      identifiers: parsed.identifiers,
      tags: parsed.tags,
      metadata: { ...parsed.metadata, coverColor: cover && (await coverColor(cover.data)) },
      files,
      cover: cover && { hash: (await backend.putFile(cover.data)).hash, mediaType: cover.mediaType },
    },
    calibre?.opf?.calibre.added,
  );
  // EPUBs that say what the item says are current with it; the rest (Calibre's metadata differing, say) are behind it.
  const key = metadataKey(item);
  const wanted = fileMetadata(item);
  for (const file of item.files) {
    const read = [...said].find(([ref]) => ref.hash === file.hash)?.[1];
    if (read && !epubMetadataChanges(read, wanted).length) file.metadataKey = key;
  }

  // Kindle files are read via EPUB, so make one straight away unless the book came with one; the original is kept.
  const kindle = stored.find(({ ref }) => KINDLE_FORMATS.includes(ref.format as FormatId) && files.includes(ref));
  const hasEpub = (list: FileRef[]) => list.some((f) => EPUB_FORMATS.includes(f.format as FormatId));
  if (kindle && !hasEpub(files) && !(existing && hasEpub(existing.files))) {
    try {
      item.files.push(await runConversion(backend, item, kindle.ref, kindle.candidate.file, [kindleToEpub]));
    } catch (e) {
      result.warnings.push({ name: kindle.candidate.file.name, message: `couldn't convert to EPUB: ${errorMessage(e)}` });
    }
  }
  return { item, existing, rating: calibre?.opf?.calibre.rating };
}

/** A Calibre book's metadata and cover; either is left out, with a warning, if it can't be read. */
async function readSidecars(
  { opf, cover }: Sidecars,
  result: ImportResult,
): Promise<{ opf?: OpfMetadata; cover?: ParsedItem['cover'] }> {
  const read: { opf?: OpfMetadata; cover?: ParsedItem['cover'] } = {};
  if (opf) {
    try {
      read.opf = parseOpf(new TextDecoder().decode(await opf.arrayBuffer()), opf.name);
      if (!read.opf) throw new Error('it has no metadata');
    } catch (e) {
      result.warnings.push({ name: pathOf(opf), message: `couldn't read Calibre's metadata: ${errorMessage(e)}` });
    }
  }
  if (cover) {
    try {
      const mediaType = coverType(cover.name)!;
      read.cover = { data: new Blob([await cover.arrayBuffer()], { type: mediaType }), mediaType };
    } catch (e) {
      result.warnings.push({ name: pathOf(cover), message: `couldn't read the cover: ${errorMessage(e)}` });
    }
  }
  return read;
}

/** Lowercase letters and digits, for comparing titles and names loosely. */
export const loose = (text: string) => text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/**
 * The item already in the library that a book's files belong with: one with the same UUID (as
 * Calibre gives each book, in its files and `metadata.opf`) or ISBN, or failing that the same
 * title and an author in common. Not one that already has a file in any
 * of these formats: a second, different EPUB of a book is more likely another edition, so it
 * gets its own item. Files a book is given on import (`files`) are what's compared.
 */
export function sameBook(known: Item[], parsed: ParsedItem, files: FileRef[]): Item | undefined {
  const formats = new Set(files.map((f) => f.format));
  const free = (item: Item) => !item.files.some((f) => formats.has(f.format));
  const uuid = parsed.identifiers.uuid?.toLowerCase();
  const byUuid = uuid && known.find((item) => free(item) && item.identifiers.uuid?.toLowerCase() === uuid);
  if (byUuid) return byUuid;
  const isbn = Object.entries(parsed.identifiers)
    .filter(([key]) => key.startsWith('isbn'))
    .map(([, value]) => normalizeIsbn(value))
    .find((value): value is string => !!value);
  if (isbn) {
    const byIsbn = known.find((item) => free(item) && hasIsbn(item, isbn));
    if (byIsbn) return byIsbn;
  }
  const title = loose(parsed.title);
  const authors = new Set(parsed.creators.map((c) => loose(c.name)).filter(Boolean));
  if (!title || !authors.size) return undefined;
  return known.find(
    (item) => free(item) && loose(item.title) === title && item.creators.some((c) => authors.has(loose(c.name))),
  );
}

const errorMessage = (e: unknown) => (e instanceof Error ? e.message : String(e));
