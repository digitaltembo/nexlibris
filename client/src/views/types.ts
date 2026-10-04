import type { ComponentType, ReactNode } from 'react';
import type { CollectionProps } from '../components/LibraryGrid';

/**
 * A way of showing the library's books, beside the built-in grid and list. A plugin adds one (see
 * `devices/types.ts`'s `Plugin.views`); it's offered in the view switcher, the View menu and Settings.
 */
export interface LibraryViewType {
  /** Stored as the chosen view; namespaced by the plugin (`bookshelf.shelf`). */
  id: string;
  /** As the menu says it: "as Bookshelf". */
  label: string;
  /** For the view switcher, in the text colour at the text's size. */
  icon: ReactNode;
  /** The books, as the grid and list get them. */
  component: ComponentType<CollectionProps>;
}
