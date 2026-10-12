import type { Item, LibraryBackend } from '@nexlibris/common';
import { hasIsbn, normalizeIsbn } from '../isbn/isbn';
import { importFiles, loose, type ImportResult } from '../library/importFiles';
import type { CatalogAuth } from './credentials';
import type { OpdsBook, OpdsDownload } from './opdsFeed';
import { downloadBook } from './remote';

/** The library's copy of a catalog's book, if it has one: by ISBN, else by title and first author. */
export function inLibrary(items: Item[], book: OpdsBook): Item | undefined {
  const isbns = book.identifiers.flatMap((id) => normalizeIsbn(id.replace(/^urn:isbn:/i, '')) ?? []);
  const byIsbn = items.find((item) => isbns.some((isbn) => hasIsbn(item, isbn)));
  if (byIsbn) return byIsbn;
  const title = loose(book.title);
  const author = book.authors[0] && loose(book.authors[0]).split(' ');
  return items.find((item) => {
    if (loose(item.title) !== title) return false;
    if (!author) return true;
    // "Shelley, Mary Wollstonecraft" and "Mary Wollstonecraft Shelley" are the same person.
    const names = item.creators.map((c) => loose(c.name).split(' '));
    return !names.length || names.some((name) => author.every((part) => name.includes(part)) || name.every((part) => author.includes(part)));
  });
}

/** Downloads a book from a catalog and imports it, as an import of the file would (merging with a copy the library has). */
export async function addFromCatalog(backend: LibraryBackend, download: OpdsDownload, auth?: CatalogAuth): Promise<ImportResult> {
  const source = await downloadBook(download.href, download.format, auth);
  return importFiles(backend, [source]);
}
