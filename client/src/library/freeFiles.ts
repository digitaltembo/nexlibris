import { referencedFiles, type FileHash, type Item, type LibraryBackend, type Operation } from '@nexlibris/common';
import { thumbnailPath } from './thumbnails';

/** The stored files an item refers to: its books' files and its cover. */
export const itemFiles = (item: Item): FileHash[] => [...item.files.map((file) => file.hash), ...(item.cover ? [item.cover.hash] : [])];

export interface Freed {
  files: number;
  bytes: number;
}

/**
 * Deletes the stored files of items that are gone (their books' files and covers, with the covers'
 * thumbnails) where no item left in the library refers to them, and says how many went and how
 * many bytes they held. A file another item shares stays.
 */
export async function freeFiles(backend: LibraryBackend, gone: Item[]): Promise<Freed> {
  const { covers, books } = referencedFiles(await backend.getLibrary());
  const used = (hash: FileHash) => covers.has(hash) || books.has(hash);
  const sizes = new Map<FileHash, number>();
  for (const item of gone) for (const hash of itemFiles(item)) sizes.set(hash, item.files.find((f) => f.hash === hash)?.size ?? 0);
  const freed: Freed = { files: 0, bytes: 0 };
  for (const [hash, size] of sizes) {
    if (used(hash)) continue;
    // The thumbnail goes whether or not the cover itself was stored here.
    await backend.deleteLocalFile(thumbnailPath(hash)).catch(() => undefined);
    if (!(await backend.hasFile(hash))) continue;
    await backend.deleteFile(hash);
    freed.files++;
    freed.bytes += size;
  }
  return freed;
}

/** Deletes items, and the files only they used. */
export async function deleteItems(backend: LibraryBackend, apply: (ops: Operation[]) => Promise<void>, items: Item[]): Promise<Freed> {
  if (!items.length) return { files: 0, bytes: 0 };
  await apply(items.map((item) => ({ type: 'removeItem', id: item.id })));
  return freeFiles(backend, items);
}

/**
 * Removes files from items (`removals`: each item's files to go, by hash), and deletes those nothing
 * else uses. A file converted from one removed keeps its place as a file in its own right (no longer
 * marked as made from it, which would have a sync treat it as out of date and leave it off devices).
 */
export async function removeFiles(
  backend: LibraryBackend,
  apply: (ops: Operation[]) => Promise<unknown>,
  removals: { item: Item; hashes: FileHash[] }[],
): Promise<Freed & { removed: number }> {
  const ops: Operation[] = [];
  let removed = 0;
  for (const { item, hashes } of removals) {
    const gone = new Set(hashes.filter((hash) => item.files.some((f) => f.hash === hash)));
    if (!gone.size) continue;
    removed += gone.size;
    for (const hash of gone) ops.push({ type: 'detachFile', id: item.id, hash });
    for (const file of item.files) {
      if (gone.has(file.hash) || !file.derivedFrom || !gone.has(file.derivedFrom.hash)) continue;
      const { derivedFrom: _source, ...own } = file;
      ops.push({ type: 'detachFile', id: item.id, hash: file.hash }, { type: 'attachFile', id: item.id, file: own });
    }
  }
  if (!ops.length) return { removed: 0, files: 0, bytes: 0 };
  await apply(ops);
  return { removed, ...(await freeFiles(backend, removals.map((r) => r.item))) };
}

/** Removes the files in `format` from `items` (as `removeFiles`). */
export function removeFormat(
  backend: LibraryBackend,
  apply: (ops: Operation[]) => Promise<unknown>,
  items: Item[],
  format: string,
): Promise<Freed & { removed: number }> {
  return removeFiles(
    backend,
    apply,
    items.map((item) => ({ item, hashes: item.files.filter((f) => f.format === format).map((f) => f.hash) })),
  );
}
