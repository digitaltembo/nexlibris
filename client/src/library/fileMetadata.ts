import { hashBlob, type FileRef, type Item } from '@nexlibris/common';
import { bookFromItem } from '@nexlibris/tools/formats/convert/bookFromItem';
import type { EpubMetadata } from '@nexlibris/tools/formats/epubMetadata';
import { isEpub, type ParsedItem } from '@nexlibris/tools/formats/formats';

/**
 * Which of a book's files are behind its metadata. A file records the fingerprint of the metadata
 * written into it (`FileRef.metadataKey`): when it's imported saying what the item says, made by a
 * converter, or rewritten by Clean up's "Update book files" (`updateFiles.ts`). Editing the book
 * changes its fingerprint, so its files are behind until they're rewritten; a rewritten file has a
 * new hash, which is what makes connections send it again. Only EPUBs (readers' ones too) can be
 * written, and a file whose fingerprint isn't known isn't counted as behind.
 *
 * The item's cover is written too, into the files it came with or was given (`writesCover`), and is then part of
 * their fingerprint. A fingerprint from before covers were written (without the cover's part) says nothing of the
 * cover, so a file with one is behind only if its other metadata is.
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

/**
 * Whether the item's cover is written into this file: an EPUB it came with or was given, not one converted from
 * another, whose converter made its cover as it wanted it (the CrossPoint optimizer's, sized and greyed for the
 * reader). And only where the item has a cover; a file's own is left otherwise.
 */
export const writesCover = (item: Item, file: Pick<FileRef, 'format' | 'derivedFrom'>) =>
  !!item.cover && canWriteMetadata(file) && !file.derivedFrom;

/** The part of a fingerprint naming the cover written. */
const COVER_PART = ':c';

/**
 * The fingerprint of what an item's files should say: its metadata, and for a file given its cover
 * (`writesCover`), the cover.
 */
export function metadataKey(item: Item, file?: Pick<FileRef, 'format' | 'derivedFrom'>): string {
  const key = `m${VERSION}:${fingerprint(JSON.stringify(fileMetadata(item)))}`;
  return file && writesCover(item, file) ? `${key}${COVER_PART}${item.cover!.hash.slice(0, 16)}` : key;
}

/** Whether a file says something other than its item does now, as far as is known. */
export function isBehind(item: Item, file: FileRef): boolean {
  if (!canWriteMetadata(file) || file.metadataKey === undefined) return false;
  // From before covers were written: only the rest is known.
  const known = file.metadataKey.includes(COVER_PART) ? metadataKey(item, file) : metadataKey(item);
  return file.metadataKey !== known;
}

/** Whether a file's own cover, as read (`parsed.cover`), isn't the one the library would write into it. */
export async function coverDiffers(item: Item, file: Pick<FileRef, 'format' | 'derivedFrom'>, parsed: Pick<ParsedItem, 'cover'>): Promise<boolean> {
  if (!writesCover(item, file)) return false;
  return !parsed.cover || (await hashBlob(parsed.cover.data)) !== item.cover!.hash;
}

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
