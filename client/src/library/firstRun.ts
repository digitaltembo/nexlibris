import type { Library } from '@nexlibris/common';

/**
 * Whether the library is new: no books, and nothing ever done to it (every change, a connection or a
 * category as much as a book, raises its revision). About opens on its own for such a library, with Get started.
 */
export const isNewLibrary = (library: Library) => library.revision === 0 && Object.keys(library.items).length === 0;
