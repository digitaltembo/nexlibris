import {
  referencedFiles,
  type FileHash,
  type FileRef,
  type Item,
  type Library,
  type LibraryBackend,
  type Operation,
} from '@nexlibris/common';
import { canWriteMetadata, fileMetadata, metadataKey } from './fileMetadata';
import { epubDrm, parseEpub } from '../formats/epub';
import { epubMetadataChanges, writeEpubMetadata } from '../formats/epubMetadata';
import type { ParsedItem } from '../formats/formats';

/**
 * Library cleanup's "Update book files": writes the library's metadata (title, creators, tags,
 * series, description, sort names and so on) into the books' own files where they say otherwise, so
 * the files carry the user's edits wherever they go. EPUBs only (the CrossPoint readers' ones too):
 * nexlibris can't write the other formats, and DRM-protected EPUBs are left alone. What the library
 * lacks is left as the file has it.
 *
 * Finding (`findStaleFiles`) reads every file and changes nothing; updating (`updateFiles`) writes
 * new files, checks each reads back as the library has it, and swaps it in for the old one: the
 * item's file, files converted from it, and reading positions in it move to the new file, then the
 * old one is deleted if nothing else uses it.
 */

export interface StaleFile {
  item: Item;
  file: FileRef;
  /** The fields that differ, e.g. `tags`, `series`. */
  changes: string[];
}

export interface Progress {
  done: number;
  total: number;
  /** The book being read or written. */
  current?: string;
}

export interface FindResult {
  stale: StaleFile[];
  /** EPUBs read and found in step. */
  current: number;
  /** Books whose files aren't stored here (another instance has them), so weren't read. */
  notHere: number;
  /** DRM-protected files, left alone. */
  drm: { title: string; kind: string }[];
  failed: { title: string; message: string }[];
  stopped?: boolean;
  /** Records the fingerprints of files found in step that didn't have them (`fileMetadata.ts`), so they're known to be current. */
  fingerprints: Operation[];
}

export interface UpdateResult {
  /** Files written. */
  updated: number;
  /** Old files deleted. */
  freed: number;
  failed: { title: string; message: string }[];
  stopped?: boolean;
}

interface Options {
  onProgress?(progress: Progress): void;
  signal?: AbortSignal;
  /** For tests: reading an EPUB's metadata. */
  parse?: (data: Blob, name: string) => Promise<ParsedItem>;
}

/** An EPUB's metadata, without its cover, which isn't compared. */
const readMetadata = (data: Blob, name: string) => parseEpub(data, name, { cover: false });

/** Changes are applied this many books at a time, so stopping partway keeps what was done. */
const APPLY_EVERY = 25;

const writable = canWriteMetadata;
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
const nameOf = (item: Item, file: FileRef) => file.name ?? `${item.title}.${file.format}`;

/** Reads every EPUB stored here and lists those whose metadata differs from the library's. */
export async function findStaleFiles(backend: LibraryBackend, library: Library, options: Options = {}): Promise<FindResult> {
  const parse = options.parse ?? readMetadata;
  const items = Object.values(library.items).filter((item) => item.files.some(writable));
  const result: FindResult = { stale: [], current: 0, notHere: 0, drm: [], failed: [], fingerprints: [] };
  for (const [done, item] of items.entries()) {
    if (options.signal?.aborted) {
      result.stopped = true;
      break;
    }
    options.onProgress?.({ done, total: items.length, current: item.title });
    const wanted = fileMetadata(item);
    const key = metadataKey(item);
    let stored = false;
    for (const file of item.files.filter(writable)) {
      try {
        if (!(await backend.hasFile(file.hash))) continue;
        stored = true;
        const data = await backend.getFile(file.hash);
        if (!data) continue;
        const drm = await epubDrm(data, nameOf(item, file));
        if (drm) {
          result.drm.push({ title: item.title, kind: drm });
          continue;
        }
        const changes = epubMetadataChanges(await parse(data, nameOf(item, file)), wanted);
        if (changes.length) result.stale.push({ item, file, changes });
        else {
          result.current++;
          if (file.metadataKey !== key) result.fingerprints.push({ type: 'setFileMetadataKey', id: item.id, hash: file.hash, metadataKey: key });
        }
      } catch (e) {
        result.failed.push({ title: item.title, message: message(e) });
      }
    }
    if (!stored) result.notHere++;
  }
  options.onProgress?.({ done: items.length, total: items.length });
  return result;
}

/**
 * The operations moving an item from its old files to their new versions (`replaced`, by old hash):
 * each replaced file, each file converted from one, and reading positions in one. Exported for tests.
 */
export function replaceFiles(library: Library, item: Item, replaced: Map<FileHash, FileRef>): Operation[] {
  const ops: Operation[] = [];
  for (const file of item.files) {
    const source = file.derivedFrom && replaced.get(file.derivedFrom.hash);
    const next = replaced.get(file.hash) ?? file;
    if (next === file && !source) continue;
    ops.push(
      { type: 'detachFile', id: item.id, hash: file.hash },
      {
        type: 'attachFile',
        id: item.id,
        file: { ...next, ...(source && file.derivedFrom && { derivedFrom: { ...file.derivedFrom, hash: source.hash } }) },
      },
    );
  }
  for (const [userId, data] of Object.entries(library.userData)) {
    const position = data.positions?.[item.id];
    const next = position && replaced.get(position.hash);
    if (!position || !next) continue;
    // The book's text is unchanged, so its locators still hold.
    const { updatedAt: _updatedAt, ...kept } = position;
    ops.push({ type: 'setPosition', userId, itemId: item.id, position: { ...kept, hash: next.hash } });
  }
  return ops;
}

/**
 * Writes the library's metadata into the `stale` files (see the top of this file). `carryText`
 * moves a file's full-text index to its new version, so the book isn't indexed again.
 */
export async function updateFiles(
  backend: LibraryBackend,
  stale: StaleFile[],
  apply: (ops: Operation[]) => Promise<unknown>,
  options: Options & { carryText?(from: FileHash, to: FileHash): Promise<void> } = {},
): Promise<UpdateResult> {
  const parse = options.parse ?? readMetadata;
  const byItem = new Map<string, StaleFile[]>();
  for (const entry of stale) byItem.set(entry.item.id, [...(byItem.get(entry.item.id) ?? []), entry]);
  const result: UpdateResult = { updated: 0, freed: 0, failed: [] };
  const old = new Set<FileHash>();
  let pending: Operation[] = [];
  let pendingBooks = 0;
  const flush = async () => {
    if (pending.length) await apply(pending);
    pending = [];
    pendingBooks = 0;
  };

  for (const [done, entries] of [...byItem.values()].entries()) {
    if (options.signal?.aborted) {
      result.stopped = true;
      break;
    }
    // The item as it is now: it may have changed since the files were found.
    const item = (await backend.getLibrary()).items[entries[0]!.item.id];
    options.onProgress?.({ done, total: byItem.size, current: entries[0]!.item.title });
    if (!item) continue;
    const wanted = fileMetadata(item);
    const replaced = new Map<FileHash, FileRef>();
    for (const { file } of entries) {
      try {
        if (!item.files.some((f) => f.hash === file.hash)) continue;
        const data = await backend.getFile(file.hash);
        if (!data) throw new Error('The file is missing from storage.');
        const drm = await epubDrm(data, nameOf(item, file));
        if (drm) throw new Error(`It’s DRM-protected (${drm}), so it’s left alone.`);
        const written = await writeEpubMetadata(data, wanted);
        // Checked before it replaces anything: it must read back as the library has it.
        const left = epubMetadataChanges(await parse(written, nameOf(item, file)), wanted);
        if (left.length) throw new Error(`It didn’t take: ${left.join(', ')}`);
        const { hash, size } = await backend.putFile(written);
        if (hash === file.hash) {
          // It said what the library says after all (it only differed in what isn't compared).
          if (file.metadataKey !== metadataKey(item)) pending.push({ type: 'setFileMetadataKey', id: item.id, hash, metadataKey: metadataKey(item) });
          continue;
        }
        // Without it, the book is only indexed again.
        await options.carryText?.(file.hash, hash).catch(() => undefined);
        replaced.set(file.hash, { ...file, hash, size, metadataKey: metadataKey(item) });
        old.add(file.hash);
        result.updated++;
      } catch (e) {
        result.failed.push({ title: item.title, message: message(e) });
      }
    }
    if (replaced.size) pending.push(...replaceFiles(await backend.getLibrary(), item, replaced));
    if (++pendingBooks >= APPLY_EVERY) await flush();
  }
  await flush();

  // The old files go once nothing refers to them (another item may share one).
  const { covers, books } = referencedFiles(await backend.getLibrary());
  for (const hash of old) {
    if (covers.has(hash) || books.has(hash) || !(await backend.hasFile(hash))) continue;
    await backend.deleteFile(hash);
    result.freed++;
  }
  options.onProgress?.({ done: byItem.size, total: byItem.size });
  return result;
}
