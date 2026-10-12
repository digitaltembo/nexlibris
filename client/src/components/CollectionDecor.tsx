import type { Item } from '@nexlibris/common';
import { createContext, useContext } from 'react';
import type { ImageFetcher } from '../catalogs/useCatalogImage';

/**
 * For views showing books that aren't the library's (a catalog's, `CatalogBrowser`): where their
 * covers are, since they aren't stored files, and a word to show on a book (e.g. "In library").
 * The library itself provides nothing, and its views show its own covers.
 */
export interface CollectionDecor {
  coverUrl?(item: Item): string | undefined;
  /** Reads a cover that needs a sign-in (see `catalogs/useCatalogImage.ts`). */
  fetchImage?: ImageFetcher;
  badge?(item: Item): string | undefined;
}

export const CollectionDecorContext = createContext<CollectionDecor>({});
export const useCollectionDecor = () => useContext(CollectionDecorContext);
