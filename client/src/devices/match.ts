import type { Item, Library } from '@nexlibris/common';
import { stripExtension } from '@nexlibris/tools/formats/formats';
import { loose } from '../library/importFiles';
import type { RemoteBook } from './types';

/** The file name without the folder or the extension (`.x4.epub` included). */
const stem = (path: string) => stripExtension(path.slice(path.lastIndexOf('/') + 1));

/**
 * The library item a book on a connection is: the same title and an author in common, from what
 * the connection knows of it, or else its file named as a sync names books (`Title - Author`).
 */
export function matchItem(library: Library, book: RemoteBook): Item | undefined {
  const items = Object.values(library.items);
  const title = book.title && loose(book.title);
  const author = book.author && loose(book.author);
  if (title && author) {
    const found = items.find((item) => loose(item.title) === title && item.creators.some((c) => loose(c.name) === author));
    if (found) return found;
  }
  const name = loose(stem(book.path));
  return items.find((item) => {
    const author = item.creators[0]?.name;
    return loose(author ? `${item.title} - ${author}` : item.title) === name;
  });
}
