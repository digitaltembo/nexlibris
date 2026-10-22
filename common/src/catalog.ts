import { userData } from './operations';
import { filterItems } from './search';
import type { Device, FileRef, Item, ItemId, Library } from './types';

/**
 * A connection's catalog: the items it holds. Those chosen by hand come first, in the order they
 * were added, then those its search matches that aren't in it yet, by title. A search's matches are
 * added to the catalog for good (the client's `catalogAdditions`) when the connection is opened or
 * synced, so a book that later stops matching stays. Items taken out (`Device.excluded`) are left
 * out either way.
 */
export function deviceItems(library: Library, device: Device): Item[] {
  const excluded = new Set(device.excluded);
  const chosen = device.items.map((id) => library.items[id]).filter((item): item is Item => !!item && !excluded.has(item.id));
  return [...chosen, ...searchMatches(library, device, new Set(device.items))];
}

/** Items a connection's search matches that aren't in its catalog (or taken out of it), by title. */
export function searchMatches(library: Library, device: Device, picked: Set<ItemId>): Item[] {
  if (!device.query?.trim()) return [];
  const excluded = new Set(device.excluded);
  return filterItems(Object.values(library.items), device.query, { ratings: userData(library).ratings })
    .filter((item) => !picked.has(item.id) && !excluded.has(item.id))
    .sort((a, b) => a.title.localeCompare(b.title, undefined, { numeric: true }) || a.id.localeCompare(b.id));
}

/**
 * The files of an item that go to a connection taking `formats` (best first): the ones chosen for
 * it there (`Device.files`), else the first it has in those formats, or with `every`, all it has in
 * them. With no formats, every file.
 */
export function deviceItemFiles(item: Item, device: Device, formats: readonly string[], every = false): FileRef[] {
  const chosen = device.files?.[item.id];
  if (chosen) return item.files.filter((file) => chosen.includes(file.hash));
  if (!formats.length) return item.files;
  const files = formats.flatMap((format) => item.files.filter((file) => file.format === format));
  return every ? files : files.slice(0, 1);
}
