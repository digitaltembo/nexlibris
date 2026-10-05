import { userData, type Device, type Item, type ItemId, type Library, type Operation } from '@nexlibris/common';
import { filterItems } from '../library/search';

/**
 * The items that go on a device: those chosen by hand, in the order they were
 * added, then those its search matches, by title. A search's matches change
 * with the library, so a book that stops matching comes off at the next sync.
 * Items kept off the device (`Device.excluded`) are left out either way.
 */
export function deviceItems(library: Library, device: Device): Item[] {
  const excluded = new Set(device.excluded);
  const chosen = device.items.map((id) => library.items[id]).filter((item): item is Item => !!item && !excluded.has(item.id));
  if (!device.query?.trim()) return chosen;
  const picked = new Set(device.items);
  const matched = filterItems(Object.values(library.items), device.query, { ratings: userData(library).ratings })
    .filter((item) => !picked.has(item.id) && !excluded.has(item.id))
    .sort((a, b) => a.title.localeCompare(b.title, undefined, { numeric: true }) || a.id.localeCompare(b.id));
  return [...chosen, ...matched];
}

/** Operations choosing items for a device by hand, no longer keeping off any that were. */
export function addToDevice(device: Device, itemIds: ItemId[]): Operation[] {
  const excluded = itemIds.filter((id) => device.excluded?.includes(id));
  return [
    { type: 'addDeviceItems', id: device.id, itemIds },
    ...(excluded.length ? [{ type: 'unexcludeDeviceItems' as const, id: device.id, itemIds: excluded }] : []),
  ];
}
