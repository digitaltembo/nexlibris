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
