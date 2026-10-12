import { normalizeMetadata, type Item, type MetadataValue } from '@nexlibris/common';
import { normalizeIsbn } from '../isbn/isbn';
import type { OpdsBook } from './opdsFeed';

/**
 * A catalog's book as the library's views show books (`Item`), so a catalog is shown as the
 * library is: grid, list, bookshelf or graph. Filled in as far as the catalog says: authors, tags,
 * identifiers (ISBN, UUID), the description and the fixed metadata fields, and its downloads as
 * files (format and size, where given). These items are only shown, never stored: their ids are
 * the catalog's, their files' hashes stand for the download links (`downloadOf`), and their covers
 * are the catalog's images (`coverUrl`), not files of the library's.
 */

const PREFIX = 'opds:';

/** An id unique to this catalog and its entry. */
export const catalogItemId = (sourceId: string, book: OpdsBook) => `${PREFIX}${sourceId}:${book.id}`;

function identifiersOf(book: OpdsBook): Record<string, string> {
  const ids: Record<string, string> = {};
  for (const raw of book.identifiers) {
    const value = raw.trim();
    const isbn = normalizeIsbn(value.replace(/^urn:isbn:/i, ''));
    if (isbn) ids.isbn ??= isbn;
    else if (/^urn:uuid:/i.test(value)) ids.uuid ??= value.slice('urn:uuid:'.length);
    else if (/^https?:\/\//i.test(value)) ids.url ??= value;
  }
  // Calibre's servers and nexlibris's export name their books by UUID in the entry's id.
  if (!ids.uuid && /^urn:uuid:/i.test(book.id)) ids.uuid = book.id.slice('urn:uuid:'.length);
  return ids;
}

/** A date the library can sort by: the day, or as much of it as there is. */
const day = (value: string | undefined) => (value && /^-?\d{4}/.test(value) ? value.slice(0, 10) : undefined);

export function opdsItem(sourceId: string, book: OpdsBook, readAt: string): Item {
  const metadata: Record<string, MetadataValue | undefined> = {
    description: book.summary,
    published: day(book.published),
    publisher: book.publisher,
    language: book.language,
    series: book.series,
    seriesIndex: book.seriesIndex,
    rights: book.rights,
  };
  // When the catalog last changed it stands for when it was added, for sorting by Recent.
  const when = book.updated && !Number.isNaN(Date.parse(book.updated)) ? new Date(book.updated).toISOString() : readAt;
  return {
    id: catalogItemId(sourceId, book),
    kind: 'book',
    title: book.title,
    creators: book.authors.map((name) => ({ name, role: 'aut' })),
    identifiers: identifiersOf(book),
    tags: book.tags,
    metadata: normalizeMetadata(Object.fromEntries(Object.entries(metadata).filter(([, v]) => v !== undefined))),
    files: book.downloads.flatMap((d) =>
      d.format ? [{ hash: `${PREFIX}${d.href}`, format: d.format, size: d.length ?? 0, ...(d.title && { name: d.title }) }] : [],
    ),
    addedAt: when,
    updatedAt: when,
  };
}

export const isCatalogItem = (item: Item) => item.id.startsWith(PREFIX);
