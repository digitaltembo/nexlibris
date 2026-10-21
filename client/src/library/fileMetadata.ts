import type { FileRef, Item } from '@nexlibris/common';
import { bookFromItem } from '@nexlibris/tools/formats/convert/bookFromItem';
import type { EpubMetadata } from '@nexlibris/tools/formats/epubMetadata';
import { isEpub } from '@nexlibris/tools/formats/formats';

/**
 * Which of a book's files are behind its metadata. A file records the fingerprint of the metadata
 * written into it (`FileRef.metadataKey`): when it's imported saying what the item says, made by a
 * converter, or rewritten by Clean up's "Update book files" (`updateFiles.ts`). Editing the book
 * changes its fingerprint, so its files are behind until they're rewritten; a rewritten file has a
 * new hash, which is what makes connections send it again. Only EPUBs (readers' ones too) can be
 * written, and a file whose fingerprint isn't known isn't counted as behind.
 */

/** Bumped when what's written into files changes, so every file counts as behind. */
const VERSION = 1;

/** What an item's files should say. */
export function fileMetadata(item: Item): EpubMetadata {
  const { identifiers: _identifiers, cover: _cover, ...metadata } = bookFromItem({ item });
  return metadata;
}

/** Whether nexlibris can write metadata into a file of this format. */
export const canWriteMetadata = (file: Pick<FileRef, 'format'>) => isEpub(file.format);

/** The fingerprint of what an item's files should say. */
export const metadataKey = (item: Item) => `m${VERSION}:${fingerprint(JSON.stringify(fileMetadata(item)))}`;

/** Whether a file says something other than its item does now, as far as is known. */
export const isBehind = (item: Item, file: FileRef) =>
  canWriteMetadata(file) && file.metadataKey !== undefined && file.metadataKey !== metadataKey(item);

/** An item's files that are behind its metadata. */
export const filesBehind = (item: Item) => item.files.filter((file) => isBehind(item, file));

/** A short, stable hash (cyrb53), enough to notice that metadata changed. */
export function fingerprint(text: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}
