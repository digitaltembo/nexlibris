import { LOCAL_USER, userData, type FileRef, type Item, type Library, type Operation, type ReadingPosition } from '@nexlibris/common';

/**
 * Currently Reading: the books read in the app and not finished, latest first, each with the file
 * and place to reopen it at (`components/CurrentlyReading.tsx`). A book is taken out of it by
 * setting its position aside (`ReadingPosition.setAside`), which keeps the place; reading it
 * again brings it back.
 */

export interface Reading {
  item: Item;
  /** The file the place is in. */
  file: FileRef;
  position: ReadingPosition;
}

/** Read this far, a book is finished. */
export const FINISHED = 0.99;

export function currentlyReading(library: Library): Reading[] {
  const positions = userData(library).positions ?? {};
  return Object.entries(positions)
    .flatMap(([itemId, position]): Reading[] => {
      if (position.setAside || (position.progress ?? 0) >= FINISHED) return [];
      const item = library.items[itemId];
      // Positions are per file: one whose file has gone has no place to reopen.
      const file = item?.files.find((f) => f.hash === position.hash);
      return item && file ? [{ item, file, position }] : [];
    })
    .sort((a, b) => b.position.updatedAt.localeCompare(a.position.updatedAt));
}

/** Takes a book out of Currently Reading, keeping its place. */
export function setAsideOperations({ item, position }: Reading): Operation[] {
  const { updatedAt: _updatedAt, ...kept } = position;
  return [{ type: 'setPosition', userId: LOCAL_USER, itemId: item.id, position: { ...kept, setAside: true } }];
}
