import {
  deviceItemFiles,
  deviceItems,
  searchMatches,
  type Device,
  type FileHash,
  type FileRef,
  type Item,
  type ItemId,
  type Library,
  type Operation,
} from '@nexlibris/common';
import type { ConnectionType } from './types';

export { deviceItems };

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
export const itemFiles = (item: Item, device: Device, type: ConnectionType, every = false): FileRef[] =>
  deviceItemFiles(item, device, type.formats(device), every);

/** Each item in a connection's catalog with its files that go there (`itemFiles`); an item with none has none there. */
export function catalogFiles(library: Library, device: Device, type: ConnectionType, every = type.access === 'export'): { item: Item; files: FileRef[] }[] {
  return deviceItems(library, device).map((item) => ({ item, files: itemFiles(item, device, type, every) }));
}
