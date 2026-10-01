import { createItem, type FileRef, type Item, type LibraryBackend, type Operation } from '@nexlibris/common';
import { hasIsbn, normalizeIsbn } from '../isbn/isbn';
import { CONVERTERS } from '../formats/convert/converters';
import { formatFromName, KINDLE_FORMATS, type FormatId, type ParsedItem } from '../formats/formats';
import { parseFile } from '../formats/parseFile';
import { runConversion } from './convert';

export interface ImportResult {
  added: Item[];
  /** Books already in the library that the import added files to, with the files' names. */
  merged: { item: Item; names: string[] }[];
  skipped: { name: string; reason: string }[];
  /** Imported, but with something to report (e.g. a failed automatic conversion). */
  warnings: { name: string; message: string }[];
}

export interface ImportOptions {
  /** Called as files are done, whether added or skipped. */
  onProgress?(done: number, total: number): void;
  /** Called each time a batch of items has been saved to the library, so they can be shown before the import ends. */
  onSaved?(): void;
}

const kindleToEpub = CONVERTERS.find((c) => c.id === 'kindle-epub')!;

/** Which format's metadata and cover an item takes, best first. Device-optimized copies come last. */
const METADATA_PREFERENCE: FormatId[] = ['epub', 'azw3', 'mobi', 'azw', 'pdf', 'cbz', 'cbr', 'rtf', 'txt', 'x4.epub', 'x3.epub'];
const EPUB_FORMATS: FormatId[] = ['epub', 'x4.epub', 'x3.epub'];

/** Items are saved this many at a time, so a long import keeps what it has done if it stops partway. */
const COMMIT_EVERY = 20;

/**
 * A file to import: a picked `File`, or one the native app has already stored (see
 * `common/src/importApi.ts`), read when its turn comes.
 */
export interface ImportSource {
  name: string;
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

/**
 * The files of one book share a name apart from the format extension (as
 * Calibre and most exports name them): `dune.epub`, `dune.mobi` and
 * `dune.x4.epub` are one item. Files picked with a folder keep their folder,
 * so same-named files in different folders stay apart.
 */
function bookKey({ file, format }: Picked) {
  const path = file.webkitRelativePath || file.name;
  return path.slice(0, path.length - format.length - 1).toLowerCase();
}

/**
 * Imports files as new items, one per book: files whose names differ only in
 * format become one item with several files. Files already in the library are
 * skipped.
 */
export async function importFiles(
  backend: LibraryBackend,
  files: ImportSource[],
  { onProgress, onSaved }: ImportOptions = {},
): Promise<ImportResult> {
  const library = await backend.getLibrary();
  const knownHashes = new Set(Object.values(library.items).flatMap((item) => item.files.map((f) => f.hash)));
  const result: ImportResult = { added: [], merged: [], skipped: [], warnings: [] };
  // Items an imported book can join: the library's, and those this import adds.
  const known: Item[] = Object.values(library.items);
  let done = 0;
  const progress = (count: number) => onProgress?.((done += count), files.length);

  const books = new Map<string, Picked[]>();
  for (const file of files) {
    const format = formatFromName(file.name);
    if (!format) {
      result.skipped.push({ name: file.name, reason: 'unsupported file type' });
      progress(1);
      continue;
    }
    const picked = { file, format };
    const key = bookKey(picked);
    books.set(key, [...(books.get(key) ?? []), picked]);
  }

  let ops: Operation[] = [];
  const commit = async () => {
    if (!ops.length) return;
    await backend.apply(ops);
    ops = [];
    onSaved?.();
  };

  for (const candidates of books.values()) {
    const imported = await importBook(backend, candidates, knownHashes, known, result);
    progress(candidates.length);
    if (!imported) continue;
    if (imported.existing) {
      const { existing, item } = imported;
      const added = item.files.filter((f) => !existing.files.some((e) => e.hash === f.hash));
      ops.push(...added.map((file): Operation => ({ type: 'attachFile', id: existing.id, file })));
      if (!existing.cover && item.cover) ops.push({ type: 'updateItem', id: existing.id, patch: { cover: item.cover } });
      const merged = { ...existing, files: [...existing.files, ...added], cover: existing.cover ?? item.cover };
      known[known.indexOf(existing)] = merged;
      const earlier = result.merged.find((m) => m.item.id === existing.id);
      const names = added.map((f) => f.name ?? f.format);
      if (earlier) earlier.names.push(...names);
      else result.merged.push({ item: merged, names });
    } else {
      ops.push({ type: 'addItem', item: imported.item });
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
 * undefined if none of them could be added.
 */
async function importBook(
  backend: LibraryBackend,
  candidates: Picked[],
  knownHashes: Set<string>,
  known: Item[],
  result: ImportResult,
): Promise<{ item: Item; existing?: Item } | undefined> {
  const rank = (c: Picked) => METADATA_PREFERENCE.indexOf(c.format);
  const stored: { candidate: Candidate; ref: FileRef }[] = [];
  for (const picked of [...candidates].sort((a, b) => rank(a) - rank(b))) {
    const { format } = picked;
    try {
      // Read the file once, since it's hashed, stored and parsed. Files the native app picked are already stored.
      const file = new File([await picked.file.arrayBuffer()], picked.file.name, { type: picked.file.type ?? '' });
      const candidate = { file, format };
      const { hash, size } = picked.file.stored ?? (await backend.putFile(file));
      if (knownHashes.has(hash)) {
        result.skipped.push({ name: file.name, reason: 'already in the library' });
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
    parsed ??= fileParsed;
    cover ??= fileParsed?.cover;
  }
  if (!parsed) return undefined;

  const existing = sameBook(known, parsed, files);
  const item = createItem({
    title: parsed.title,
    creators: parsed.creators,
    identifiers: parsed.identifiers,
    tags: parsed.tags,
    metadata: parsed.metadata,
    files,
    cover: cover && { hash: (await backend.putFile(cover.data)).hash, mediaType: cover.mediaType },
  });

  // Kindle files are read via EPUB, so make one straight away unless the book came with one; the original is kept.
  const kindle = stored.find(({ ref }) => KINDLE_FORMATS.includes(ref.format as FormatId) && files.includes(ref));
  const hasEpub = (list: FileRef[]) => list.some((f) => EPUB_FORMATS.includes(f.format as FormatId));
  if (kindle && !hasEpub(files) && !(existing && hasEpub(existing.files))) {
    try {
      item.files.push(await runConversion(backend, item, kindle.ref, kindle.candidate.file, kindleToEpub));
    } catch (e) {
      result.warnings.push({ name: kindle.candidate.file.name, message: `couldn't convert to EPUB: ${errorMessage(e)}` });
    }
  }
  return { item, existing };
}

/** Lowercase letters and digits, for comparing titles and names loosely. */
const loose = (text: string) => text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/**
 * The item already in the library that a book's files belong with: one with the same ISBN, or
 * failing that the same title and an author in common. Not one that already has a file in any
 * of these formats: a second, different EPUB of a book is more likely another edition, so it
 * gets its own item. Files a book is given on import (`files`) are what's compared.
 */
export function sameBook(known: Item[], parsed: ParsedItem, files: FileRef[]): Item | undefined {
  const formats = new Set(files.map((f) => f.format));
  const free = (item: Item) => !item.files.some((f) => formats.has(f.format));
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
