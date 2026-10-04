import type { Device, FileRef, Item, ItemId, Library, PlacedFile } from '@nexlibris/common';
import type { Converter } from '../formats/convert/converters';
import type { Catalog, ConnectionType, DeviceTarget, DeviceType, RemoteFile } from './types';
import { deviceItems } from './selection';

/** A file to put on the device. */
export interface Upload {
  path: string;
  item: Item;
  file: FileRef;
  /** From the device type's preparation, recorded so the next sync can tell whether the file is current. */
  key?: string;
  /** Make the device's format from `file` with this first, and keep the result in the library. */
  convert?: Converter;
  /** Replacing a file a sync put there before, e.g. after the book's metadata changed. */
  replaces: boolean;
  /** The book's old copy under another name, removed once this one is sent. */
  supersedes?: string;
}

/** A file that's in the way, left alone. */
export interface Conflict {
  path: string;
  itemId: ItemId;
  reason: string;
}

export interface SyncPlan {
  uploads: Upload[];
  /** Files a sync put there that are no longer wanted, or that were sent again under a new name. */
  removals: string[];
  /** Records of files that are gone from the device, or were changed on it, so are no longer the sync's. */
  forget: string[];
  conflicts: Conflict[];
  /** Items with no file in a format the device takes. */
  unsendable: ItemId[];
  /** Files already on the device as they should be. */
  unchanged: number;
  /** The device's catalog, to add to its list of catalogs. */
  catalog?: Catalog;
}

/** What's on the device now. */
export interface DeviceListing {
  files: RemoteFile[];
  catalogs?: Catalog[];
}

/** A file the plan wants on the device, and how to make it. */
export interface Wanted {
  item: Item;
  file: FileRef;
  key?: string;
  convert?: Converter;
}

const isCurrent = (placed: PlacedFile, wanted: Wanted) =>
  !wanted.convert && placed.hash === wanted.file.hash && placed.key === wanted.key;

/** Files `converter` made that are out of date: from an older version of it, or from a source no longer there. */
export function staleFiles(item: Item, converter: Converter | undefined): FileRef[] {
  return item.files.filter(
    (f) =>
      converter &&
      f.derivedFrom?.converter === converter.id &&
      (f.derivedFrom.converterVersion !== converter.version || !item.files.some((s) => s.hash === f.derivedFrom!.hash)),
  );
}

/** What to send for an item: its best file in a format the device takes, or one to make with the type's converter. */
export function chooseFile(item: Item, type: ConnectionType, makes: Converter | undefined): { file: FileRef; convert?: Converter } | undefined {
  const stale = staleFiles(item, makes);
  const files = item.files.filter((f) => !stale.includes(f));
  for (const format of type.formats) {
    const file = files.find((f) => f.format === format);
    if (file) return { file };
    const source = makes?.to === format && makes.from.map((from) => files.find((f) => f.format === from)).find((f) => f);
    if (source) return { file: source, convert: makes };
  }
  return undefined;
}

/** What should be on the device: a path for each chosen item that has a file in a format it takes. */
export function desiredFiles(library: Library, device: Device, type: DeviceType) {
  const files = new Map<string, Wanted>();
  const unsendable: ItemId[] = [];
  const folder = type.folder(device);
  const placedPath = new Map(Object.entries(device.placed).map(([path, p]) => [p.itemId, path]));
  const chosen: Wanted[] = [];
  const makes = type.makes?.(device);
  for (const item of deviceItems(library, device)) {
    const choice = chooseFile(item, type, makes);
    if (choice) chosen.push({ item, ...choice, key: type.prepare?.key(item, choice.file) });
    else unsendable.push(item.id);
  }
  // A book already on the device keeps its path while it's current, or while its name would be the same; one
  // sent again with a new title or author goes under its new name. The rest are named around them.
  const named = new Set<ItemId>();
  for (const wanted of chosen) {
    const path = placedPath.get(wanted.item.id);
    if (!path || files.has(path)) continue;
    if (isCurrent(device.placed[path]!, wanted) || path === bookPath(folder, wanted.item, wanted.file)) {
      files.set(path, wanted);
      named.add(wanted.item.id);
    }
  }
  for (const wanted of chosen) {
    if (!named.has(wanted.item.id)) files.set(uniquePath(files, folder, wanted.item, wanted.file), wanted);
  }
  return { files, unsendable };
}

/** Compares what should be on the device with what a sync placed there before and what's there now. */
export function planSync(library: Library, device: Device, type: DeviceType, listing: DeviceListing): SyncPlan {
  const { files, unsendable } = desiredFiles(library, device, type);
  const sizes = new Map(listing.files.map((f) => [f.path, f.size]));
  const plan: SyncPlan = { uploads: [], removals: [], forget: [], conflicts: [], unsendable, unchanged: 0 };
  const upload = (path: string, wanted: Wanted, replaces: boolean) => plan.uploads.push({ path, ...wanted, replaces });

  for (const [path, placed] of Object.entries(device.placed)) {
    const size = sizes.get(path);
    const wanted = files.get(path);
    if (size === undefined) {
      // Deleted on the device: send it again if it's still wanted.
      plan.forget.push(path);
      if (wanted) upload(path, wanted, false);
    } else if (size !== placed.size) {
      // Someone replaced it on the device; it's theirs now.
      plan.forget.push(path);
      if (wanted) plan.conflicts.push({ path, itemId: wanted.item.id, reason: 'It was changed on the device since it was sent.' });
    } else if (!wanted) {
      plan.removals.push(path);
    } else if (isCurrent(placed, wanted)) {
      plan.unchanged++;
    } else {
      upload(path, wanted, true);
    }
  }
  for (const [path, wanted] of files) {
    if (device.placed[path]) continue;
    if (sizes.has(path)) {
      plan.conflicts.push({ path, itemId: wanted.item.id, reason: 'A file nexlibris didn’t send is already there.' });
    } else {
      upload(path, wanted, false);
    }
  }
  // A book sent under a new name replaces its old copy, which is in the removals.
  for (const u of plan.uploads) {
    const old = plan.removals.find((path) => device.placed[path]!.itemId === u.item.id);
    if (old) Object.assign(u, { replaces: true, supersedes: old });
  }
  const catalog = type.catalog?.(device);
  if (catalog && listing.catalogs && !listing.catalogs.some((c) => sameUrl(c.url, catalog.url))) plan.catalog = catalog;
  return plan;
}

/** Lists the folders a sync touches (where books go, and wherever earlier syncs put files), and the catalogs. */
export async function listDevice(device: Device, type: DeviceType, target: DeviceTarget): Promise<DeviceListing> {
  const files = (await Promise.all([...syncFolders(device, type)].map((folder) => target.list(folder)))).flat();
  const catalogs = type.catalog?.(device) && target.listCatalogs ? await target.listCatalogs() : undefined;
  return { files, ...(catalogs && { catalogs }) };
}

const sameUrl = (a: string, b: string) => a.trim().replace(/\/+$/, '') === b.trim().replace(/\/+$/, '');

export const parentOf = (path: string) => path.slice(0, path.lastIndexOf('/')) || '/';

/** The folders a sync lists: the type's folder for books, and each folder it has put a book in. */
export const syncFolders = (device: Device, type: DeviceType) =>
  new Set([type.folder(device), ...Object.keys(device.placed).map(parentOf)]);

/** Characters FAT file systems (and so SD cards) don't allow, plus control characters. */
// oxlint-disable-next-line no-control-regex -- matching control characters is the point.
const UNSAFE = /[\\/:*?"<>|\u0000-\u001f]/g;

function safeName(text: string) {
  // No leading dot: CrossPoint hides dotfiles and won't create them.
  return text.replace(UNSAFE, ' ').replace(/\s+/g, ' ').trim().replace(/^\.+/, '').replace(/[. ]+$/, '').slice(0, 80);
}

/** `<folder>/<Title> - <Author>.<ext>`, or with ` (n)` before the extension as the nth book of that name. */
function bookPath(folder: string, item: Item, file: FileRef, n = 1) {
  const author = item.creators[0]?.name;
  const base = safeName(author ? `${item.title} - ${author}` : item.title) || 'Untitled';
  // A device takes x4.epub as a plain EPUB; the name doesn't need to say it's optimized.
  const extension = file.format.split('.').pop();
  return `${folder.replace(/\/+$/, '')}/${n === 1 ? base : `${base} (${n})`}.${extension}`;
}

/** The book's path, numbered if another item already has it. */
function uniquePath(taken: Map<string, unknown>, folder: string, item: Item, file: FileRef) {
  for (let n = 1; ; n++) {
    const path = bookPath(folder, item, file, n);
    if (!taken.has(path)) return path;
  }
}
