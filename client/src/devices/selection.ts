import { userData, type Device, type Item, type Library } from '@nexlibris/common';
import { filterItems } from '../library/search';

/**
 * The items that go on a device: those chosen by hand, in the order they were
 * added, then those its search matches, by title. A search's matches change
 * with the library, so a book that stops matching comes off at the next sync.
 */
export function deviceItems(library: Library, device: Device): Item[] {
  const chosen = device.items.map((id) => library.items[id]).filter((item): item is Item => !!item);
  if (!device.query?.trim()) return chosen;
  const picked = new Set(device.items);
  const matched = filterItems(Object.values(library.items), device.query, { ratings: userData(library).ratings })
    .filter((item) => !picked.has(item.id))
    .sort((a, b) => a.title.localeCompare(b.title, undefined, { numeric: true }) || a.id.localeCompare(b.id));
  return [...chosen, ...matched];
}
