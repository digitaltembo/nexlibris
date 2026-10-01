import { bookFromItem } from '../formats/convert/bookFromItem';
import { writeEpubMetadata, type EpubMetadata } from '../formats/epubMetadata';
import type { Preparation } from './types';

/** Bumped when the output changes for the same input, so devices get the new version. */
const VERSION = 1;

const EPUB_FORMATS = ['epub', 'x4.epub', 'x3.epub'];

/** Writes the item's current metadata into EPUBs as they're sent, so edits in the library show on the device. */
export const embedMetadata: Preparation = {
  key(item, file) {
    if (!EPUB_FORMATS.includes(file.format)) return undefined;
    return `meta${VERSION}:${fingerprint(JSON.stringify(metadataFor(bookFromItem({ item }))))}`;
  },
  run(item, _file, data) {
    return writeEpubMetadata(data, metadataFor(bookFromItem({ item })));
  },
};

function metadataFor({ identifiers: _identifiers, cover: _cover, ...metadata }: ReturnType<typeof bookFromItem>): EpubMetadata {
  return metadata;
}

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
