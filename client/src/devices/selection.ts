import { userData, type Device, type FileHash, type FileRef, type Item, type ItemId, type Library, type Operation } from '@nexlibris/common';
import { filterItems } from '../library/search';
import type { ConnectionType } from './types';

/**
 * A connection's catalog: the items it holds. Those chosen by hand come first, in the order they
 * were added, then those its search matches that aren't in it yet, by title. A search's matches are
 * added to the catalog for good (`catalogAdditions`) when the connection is opened or synced, so a
 * book that later stops matching stays. Items taken out (`Device.excluded`) are left out either way.
 */
export function deviceItems(library: Library, device: Device): Item[] {
  const excluded = new Set(device.excluded);
  const chosen = device.items.map((id) => library.items[id]).filter((item): item is Item => !!item && !excluded.has(item.id));
  return [...chosen, ...searchMatches(library, device, new Set(device.items))];
}

/** Items a connection's search matches that aren't in its catalog (or taken out of it), by title. */
function searchMatches(library: Library, device: Device, picked: Set<ItemId>): Item[] {
  if (!device.query?.trim()) return [];
  const excluded = new Set(device.excluded);
  return filterItems(Object.values(library.items), device.query, { ratings: userData(library).ratings })
    .filter((item) => !picked.has(item.id) && !excluded.has(item.id))
    .sort((a, b) => a.title.localeCompare(b.title, undefined, { numeric: true }) || a.id.localeCompare(b.id));
}

/** Operations adding what a connection's search matches now to its catalog, so they stay once they stop matching. */
export function catalogAdditions(library: Library, device: Device): Operation[] {
  const matched = searchMatches(library, device, new Set(device.items)).map((item) => item.id);
  return matched.length ? [{ type: 'addDeviceItems', id: device.id, itemIds: matched }] : [];
}

/** Operations adding items to a connection's catalog by hand: whole (any particular files dropped), and no longer taken out. */
export function addToDevice(device: Device, itemIds: ItemId[]): Operation[] {
  const excluded = itemIds.filter((id) => device.excluded?.includes(id));
  return [
    { type: 'addDeviceItems', id: device.id, itemIds },
    ...itemIds.filter((id) => device.files?.[id]).map((itemId): Operation => ({ type: 'setDeviceFiles', id: device.id, itemId, hashes: undefined })),
    ...(excluded.length ? [{ type: 'unexcludeDeviceItems' as const, id: device.id, itemIds: excluded }] : []),
  ];
}

/**
 * Operations adding one file of an item to a connection's catalog: the item holds just its chosen
 * files there, this one among them. An item already in it whole gets this file as well as the one its
 * formats picked, as that's what it had.
 */
export function addFileToDevice(library: Library, device: Device, type: ConnectionType, item: Item, hash: FileHash): Operation[] {
  const current = device.files?.[item.id] ?? (deviceItems(library, device).some((i) => i.id === item.id) ? itemFiles(item, device, type).map((f) => f.hash) : []);
  const hashes = [...new Set([...current, hash])];
  return [
    { type: 'setDeviceFiles', id: device.id, itemId: item.id, hashes },
    ...(device.excluded?.includes(item.id) ? [{ type: 'unexcludeDeviceItems' as const, id: device.id, itemIds: [item.id] }] : []),
  ];
}

/**
 * Operations taking items out of a connection's catalog by hand: chosen ones unchosen, and kept out
 * if its search would add them again. What was sent stays where it is.
 */
export function takeOutOfDevice(library: Library, device: Device, itemIds: ItemId[]): Operation[] {
  const ids = new Set(itemIds);
  const chosen = itemIds.filter((id) => device.items.includes(id));
  const unpicked = { ...device, items: device.items.filter((id) => !ids.has(id)) };
  const matched = new Set(searchMatches(library, unpicked, new Set(unpicked.items)).map((item) => item.id));
  const keepOut = itemIds.filter((id) => matched.has(id) && !device.excluded?.includes(id));
  return [
    ...(chosen.length ? [{ type: 'removeDeviceItems' as const, id: device.id, itemIds: chosen }] : []),
    ...(keepOut.length ? [{ type: 'excludeDeviceItems' as const, id: device.id, itemIds: keepOut }] : []),
  ];
}

/** Whether an item is in a connection's catalog. */
export const inCatalog = (library: Library, device: Device, itemId: ItemId) =>
  !device.excluded?.includes(itemId) && (device.items.includes(itemId) || deviceItems(library, device).some((item) => item.id === itemId));

/**
 * The files of an item that go to a connection: the ones chosen for it there (`Device.files`), else
 * the first it has in the type's formats, best first, or with `every`, all it has in them. A type
 * that takes every format (an instance) takes every file.
 */
export function itemFiles(item: Item, device: Device, type: ConnectionType, every = false): FileRef[] {
  const chosen = device.files?.[item.id];
  if (chosen) return item.files.filter((file) => chosen.includes(file.hash));
  const formats = type.formats(device);
  if (!formats.length) return item.files;
  const files = formats.flatMap((format) => item.files.filter((file) => file.format === format));
  return every ? files : files.slice(0, 1);
}

/** Each item in a connection's catalog with its files that go there (`itemFiles`); an item with none has none there. */
export function catalogFiles(library: Library, device: Device, type: ConnectionType, every = type.access === 'export'): { item: Item; files: FileRef[] }[] {
  return deviceItems(library, device).map((item) => ({ item, files: itemFiles(item, device, type, every) }));
}
