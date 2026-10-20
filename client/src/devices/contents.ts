import { hashBlob, type Device, type Item, type Library, type LibraryBackend, type Operation, type PlacedFile } from '@nexlibris/common';
import { importFiles } from '../library/importFiles';
import { matchItem } from './match';
import { chooseFile, desiredFiles, isCurrent, type Wanted } from './plan';
import { addToDevice, deviceItems, itemFiles, takeOutOfDevice } from './selection';
export { matchItem } from './match';
import { isFiles, type ConnectionType, type DeviceTarget, type RemoteBook } from './types';

/**
 * What's on a connection, set against the library: the books a sync put there and how they stand,
 * those that match a library book, and those the library doesn't have, which can be brought in.
 * Linking or importing one makes it the connection's, so later syncs keep it in step rather than
 * treating it as someone else's file. For a catalog, what's on it is what its last export wrote.
 */
export type ContentEntry =
  | {
      kind: 'placed';
      book: RemoteBook;
      /** Undefined if the item has since been removed from the library. */
      item?: Item;
      /**
       * `current`: as the next sync would send it; `update`: it would send a newer copy (under the
       * book's own name, if this one's named otherwise); `left`: no longer in the catalog, so left
       * there as it is; `changed`: replaced on the device, so no longer the sync's.
       */
      status: 'current' | 'update' | 'left' | 'changed';
    }
  | {
      kind: 'match';
      book: RemoteBook;
      item: Item;
      /** Whether the item has a file the connection takes, so it can be linked: the next sync then keeps it in step. */
      linkable: boolean;
    }
  | { kind: 'unknown'; book: RemoteBook };

export interface Contents {
  entries: ContentEntry[];
  /** In the connection's catalog but not on it: the next sync sends them. */
  pending: Item[];
}

/** Sorts what's on a connection (`books`, as its inventory lists them) against the library and the connection's choice. */
export function connectionContents(library: Library, device: Device, type: ConnectionType, books: RemoteBook[]): Contents {
  const wanted = isFiles(type) ? desiredFiles(library, device, type).files : undefined;
  const chosen = new Set(deviceItems(library, device).map((item) => item.id));
  const on = new Set<string>();
  const entries = books.map((book): ContentEntry => {
    const placed = device.placed[book.path];
    if (placed) {
      on.add(placed.itemId);
      const item = library.items[placed.itemId];
      return { kind: 'placed', book, ...(item && { item }), status: placedStatus(placed, book, item, chosen, wanted, wanted?.get(book.path)) };
    }
    const item = matchItem(library, book);
    if (item) {
      on.add(item.id);
      return { kind: 'match', book, item, linkable: !!chooseFile(item, device, type) };
    }
    return { kind: 'unknown', book };
  });
  const pending = deviceItems(library, device).filter((item) => !on.has(item.id));
  return { entries, pending };
}

function placedStatus(
  placed: PlacedFile,
  book: RemoteBook,
  item: Item | undefined,
  chosen: Set<string>,
  plan: Map<string, Wanted> | undefined,
  wanted: Wanted | undefined,
): Extract<ContentEntry, { kind: 'placed' }>['status'] {
  if (book.size !== placed.size) return 'changed';
  if (!item || !chosen.has(item.id)) return 'left';
  // A catalog has no plan to compare with: what it wrote is current until the next export.
  if (!plan) return 'current';
  // Not wanted at this path: the sync sends it again under its own name, replacing this copy.
  if (!wanted) return 'update';
  return isCurrent(placed, wanted) ? 'current' : 'update';
}

/**
 * Makes a file on a device the connection's copy of `item`: the item joins the connection's
 * catalog if it isn't in it, and the file is recorded as current, so the next sync leaves it be
 * until the library's copy changes, then replaces it.
 */
export function linkOperations(library: Library, device: Device, type: ConnectionType, book: RemoteBook, item: Item): Operation[] {
  // The file in the format its name says, if the item has one (the longest such format: x4.epub over epub), else the one a sync would send.
  const named = itemFiles(item, device, type, true)
    .filter((file) => book.path.toLowerCase().endsWith(`.${file.format}`))
    .sort((a, b) => b.format.length - a.format.length)[0];
  const choice = named ? { file: named } : chooseFile(item, device, type);
  if (!choice) throw new Error(`${item.title} has no file this connection takes.`);
  const ops: Operation[] = [];
  if (!deviceItems(library, device).some((i) => i.id === item.id)) ops.push(...addToDevice(device, [item.id]));
  const placed: PlacedFile = { itemId: item.id, hash: choice.file.hash, size: book.size, linked: true, found: true };
  ops.push({ type: 'recordDeviceSync', id: device.id, placed: { [book.path]: placed }, removed: [] });
  return ops;
}

/**
 * Taking a book off a device by hand, once its file there is deleted: the book is taken out of the
 * connection's catalog (kept out, if its search would add it), so the next sync doesn't send it
 * again, and the file is forgotten if a sync put it there. A book the library doesn't have needs nothing.
 */
export function removeOperations(library: Library, device: Device, entry: ContentEntry): Operation[] {
  const item = entry.kind === 'unknown' ? undefined : entry.item;
  return [
    ...(item ? takeOutOfDevice(library, device, [item.id]) : []),
    ...(device.placed[entry.book.path] ? [{ type: 'recordDeviceSync' as const, id: device.id, placed: {}, removed: [entry.book.path] }] : []),
  ];
}

/**
 * Brings a book on a device into the library (as a new item, or as another file of the book it
 * matches), then links the file to it if the connection takes a file the item now has. Returns
 * the item, and whether it was linked.
 */
export async function importFromConnection(
  backend: LibraryBackend,
  device: Device,
  type: ConnectionType,
  target: DeviceTarget,
  book: RemoteBook,
): Promise<{ item: Item; linked: boolean }> {
  if (!target.download) throw new Error('This device can’t send files back.');
  // A connection that knows its books' details (a folder's manifest) brings them in as it has them.
  const described = isFiles(type) && type.download ? await type.download(device, target, book, backend) : undefined;
  if (described) {
    const library = await backend.getLibrary();
    const current = library.devices?.[device.id] ?? device;
    if (!chooseFile(described, current, type)) return { item: described, linked: false };
    await backend.apply(linkOperations(library, current, type, book, described));
    return { item: described, linked: true };
  }
  const name = book.path.slice(book.path.lastIndexOf('/') + 1);
  const data = await target.download(book.path);
  const result = await importFiles(backend, [new File([data], name)]);
  const skipped = result.skipped[0];
  const library = await backend.getLibrary();
  const id = result.added[0]?.id ?? result.merged[0]?.item.id;
  // The library has this very file already, so the import skipped it: the item with it is the one.
  const hash = id ? undefined : await hashBlob(data);
  const item = id ? library.items[id] : Object.values(library.items).find((i) => i.files.some((f) => f.hash === hash));
  if (!item) throw new Error(skipped ? `${name}: ${skipped.reason}` : `${name} couldn’t be imported.`);
  const current = library.devices?.[device.id] ?? device;
  if (!chooseFile(item, current, type)) return { item, linked: false };
  await backend.apply(linkOperations(library, current, type, book, item));
  return { item, linked: true };
}
