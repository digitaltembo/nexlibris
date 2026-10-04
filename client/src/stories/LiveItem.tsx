import type { Item } from '@nexlibris/common';
import type { ReactNode } from 'react';
import { useLibrary } from '../library/LibraryContext';

/**
 * Renders `children` with an item as it currently is in the story's library, so edits made in the
 * story show, as they would in the app. `id` is one of the sample items'.
 */
export function LiveItem({ id, children }: { id: string; children(item: Item): ReactNode }) {
  const { library } = useLibrary();
  const item = library.items[id];
  return item ? children(item) : <p>That item was deleted. Pick another story to start again.</p>;
}
