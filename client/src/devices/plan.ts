import type { Device, FileRef, Item, ItemId, Library, PlacedFile } from '@nexlibris/common';
import type { Converter } from '../formats/convert/converters';
import { matchItem } from './match';
import type { Catalog, ConnectionType, DeviceTarget, DeviceType, RemoteBook, RemoteFile } from './types';
import { DEFAULT_FILE_NAME, expandPath, hasPlaceholders, templateRoot } from './pathTemplate';
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

/** A book already on the device, as it should be, but at a path it no longer belongs at. */
export interface Move {
  from: string;
  to: string;
  /** The record of the file, which moves with it. */
  placed: PlacedFile;
  /** A copy nexlibris didn't send, found on the device and taken as the book's (`PlacedFile.found`). */
  found?: boolean;
}

/** A copy nexlibris didn't send, found where the book goes and taken as the book's, so it isn't sent again. */
export interface Kept {
  path: string;
  placed: PlacedFile;
}

/** A file that's in the way, left alone. */
export interface Conflict {
  path: string;
  itemId: ItemId;
  reason: string;
}

export interface SyncPlan {
  uploads: Upload[];
  /** Books moved to their new paths rather than sent again (when the device can move files). */
  moves: Move[];
  /** Copies found where their books go, recorded as the books' own. */
  kept: Kept[];
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
  /** Folders the sync may leave empty, deepest first, removed if they are (the device refuses ones that aren't). */
  emptied: string[];
}

/** What's on the device now. */
export interface DeviceListing {
  files: RemoteFile[];
  catalogs?: Catalog[];
  /** The device can move files (`DeviceTarget.move`). */
  canMove?: boolean;
  /**
   * Everything on the device, as its inventory lists it (with what the device knows of each book), for finding
   * copies of chosen books the sync didn't send; `files` when not given.
   */
  found?: RemoteBook[];
}

export interface PlanOptions {
  /** Take copies of chosen books already on the device (put there by hand, or by other software) as theirs, rather than sending them again. */
  keepFound?: boolean;
}

/** A file the plan wants on the device, and how to make it. */
export interface Wanted {
  item: Item;
  file: FileRef;
  key?: string;
  convert?: Converter;
}

/**
 * Whether a file on the device is as the plan wants it. A copy nexlibris didn't make stands for the library's
 * file it was taken as, before any conversion, so it isn't remade while that file and the key are unchanged.
 */
export const isCurrent = (placed: PlacedFile, wanted: Wanted) =>
  (!wanted.convert || !!placed.found) && placed.hash === wanted.file.hash && placed.key === wanted.key;

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
  const pathOf = bookPaths(device, type);
  const placedPath = new Map(Object.entries(device.placed).map(([path, p]) => [p.itemId, path]));
  const chosen: Wanted[] = [];
  const makes = type.makes?.(device);
  for (const item of deviceItems(library, device)) {
    const choice = chooseFile(item, type, makes);
    if (choice) chosen.push({ item, ...choice, key: type.prepare?.key(item, choice.file) });
    else unsendable.push(item.id);
  }
  // A book already on the device keeps its path while that's still its path (numbered as it was, if it was), or,
  // linked by hand, while it's current; one whose path has changed, by a new title or author or new templates,
  // goes to its new one. The rest are named around them.
  const named = new Set<ItemId>();
  for (const wanted of chosen) {
    const path = placedPath.get(wanted.item.id);
    if (!path || files.has(path)) continue;
    const n = Number(/ \((\d+)\)\.[^./]+$/.exec(path)?.[1] ?? 1);
    // A file linked by hand stays where it was put while it's current.
    const linked = device.placed[path]!.linked && isCurrent(device.placed[path]!, wanted);
    if (linked || path === pathOf(wanted.item, wanted.file, n)) {
      files.set(path, wanted);
      named.add(wanted.item.id);
    }
  }
  for (const wanted of chosen) {
    if (named.has(wanted.item.id)) continue;
    for (let n = 1; ; n++) {
      const path = pathOf(wanted.item, wanted.file, n);
      if (!files.has(path)) {
        files.set(path, wanted);
        break;
      }
    }
  }
  return { files, unsendable };
}

/** Compares what should be on the device with what a sync placed there before and what's there now. */
export function planSync(library: Library, device: Device, type: DeviceType, listing: DeviceListing, options: PlanOptions = {}): SyncPlan {
  const { files, unsendable } = desiredFiles(library, device, type);
  const sizes = new Map(listing.files.map((f) => [f.path, f.size]));
  const plan: SyncPlan = { uploads: [], moves: [], kept: [], removals: [], forget: [], conflicts: [], unsendable, unchanged: 0, emptied: [] };
  const found = options.keepFound === false ? new Map<ItemId, RemoteBook[]>() : foundCopies(library, device, listing, files);
  /** A found copy of the wanted book that can be its file at `path`: there already, or (if the device can move files) anywhere. */
  const foundFor = (path: string, wanted: Wanted) => {
    const extension = path.slice(path.lastIndexOf('.'));
    const copies = (found.get(wanted.item.id) ?? []).filter((book) => book.path.toLowerCase().endsWith(extension.toLowerCase()));
    const copy = copies.find((book) => book.path === path) ?? (listing.canMove ? copies.find((book) => !files.has(book.path)) : undefined);
    if (!copy) return undefined;
    found.delete(wanted.item.id);
    const placed: PlacedFile = { itemId: wanted.item.id, hash: wanted.file.hash, size: copy.size, found: true, ...(wanted.key !== undefined && { key: wanted.key }) };
    if (copy.path === path) plan.kept.push({ path, placed });
    else plan.moves.push({ from: copy.path, to: path, placed, found: true });
    return copy;
  };
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
      if (!foundFor(path, wanted)) plan.conflicts.push({ path, itemId: wanted.item.id, reason: 'A file nexlibris didn’t send is already there.' });
    } else if (!foundFor(path, wanted)) {
      upload(path, wanted, false);
    }
  }
  // A book sent under a new name replaces its old copy, which is in the removals; if the copy is as it should
  // be, and the device can, it's moved instead.
  for (const u of [...plan.uploads]) {
    const old = plan.removals.find((path) => device.placed[path]!.itemId === u.item.id);
    if (!old) continue;
    const placed = device.placed[old]!;
    if (listing.canMove && isCurrent(placed, u)) {
      plan.moves.push({ from: old, to: u.path, placed });
      plan.uploads.splice(plan.uploads.indexOf(u), 1);
      plan.removals.splice(plan.removals.indexOf(old), 1);
    } else {
      Object.assign(u, { replaces: true, supersedes: old });
    }
  }
  plan.emptied = emptiedFolders(device, type, [...plan.removals, ...plan.moves.map((m) => m.from)], files);
  const catalog = type.catalog?.(device);
  if (catalog && listing.catalogs && !listing.catalogs.some((c) => sameUrl(c.url, catalog.url))) plan.catalog = catalog;
  return plan;
}

/**
 * Lists the folders a sync touches (where books go, by the library's books when it's given, and wherever
 * earlier syncs put files), and the catalogs.
 */
export async function listDevice(device: Device, type: DeviceType, target: DeviceTarget, library?: Library): Promise<DeviceListing> {
  const folders = [...syncFolders(device, type, library)];
  const files = (await Promise.all(folders.map((folder) => target.list(folder)))).flat();
  const catalogs = type.catalog?.(device) && target.listCatalogs ? await target.listCatalogs() : undefined;
  return { files, ...(catalogs && { catalogs }), ...(target.move && { canMove: true }) };
}

/**
 * Copies of the device's chosen books that a sync didn't send, by item: books on the device that
 * match one (by the device's metadata, a file named as a sync names them by default, or one at the
 * path the templates give it), newest first.
 */
function foundCopies(library: Library, device: Device, listing: DeviceListing, wanted: Map<string, Wanted>): Map<ItemId, RemoteBook[]> {
  const chosen = new Set(deviceItems(library, device).map((item) => item.id));
  const placedItems = new Set(Object.values(device.placed).map((p) => p.itemId));
  const copies = new Map<ItemId, RemoteBook[]>();
  for (const book of listing.found ?? listing.files) {
    if (device.placed[book.path]) continue;
    const item = matchItem(library, book) ?? wanted.get(book.path)?.item;
    if (!item || !chosen.has(item.id) || placedItems.has(item.id)) continue;
    copies.set(item.id, [...(copies.get(item.id) ?? []), book]);
  }
  return copies;
}

const sameUrl = (a: string, b: string) => a.trim().replace(/\/+$/, '') === b.trim().replace(/\/+$/, '');

export const parentOf = (path: string) => path.slice(0, path.lastIndexOf('/')) || '/';

/**
 * The folders a sync lists: the fixed part of the type's folder template, each folder it has put a
 * book in, and (given the library) each folder the device's books now go in.
 */
export function syncFolders(device: Device, type: DeviceType, library?: Library): Set<string> {
  const folders = new Set([templateRoot(type.folder(device)), ...Object.keys(device.placed).map(parentOf)]);
  if (library && hasPlaceholders(type.folder(device))) {
    for (const path of desiredFiles(library, device, type).files.keys()) folders.add(parentOf(path));
  }
  return folders;
}

/**
 * A device's book paths: the item's path by the type's templates, numbered ` (n)` as the nth book with
 * that path. A device takes x4.epub as a plain EPUB, so the name doesn't say it's optimized.
 */
export function bookPaths(device: Device, type: DeviceType) {
  const folder = type.folder(device);
  const fileName = type.fileName?.(device) ?? DEFAULT_FILE_NAME;
  return (item: Item, file: FileRef, n = 1) => expandPath(folder, fileName, item, file.format.split('.').pop()!, n);
}

/**
 * Folders that files are leaving (and their parents), below the template's fixed part and not
 * where wanted books go, deepest first: removed after a sync if empty.
 */
function emptiedFolders(device: Device, type: DeviceType, leaving: string[], wanted: Map<string, unknown>): string[] {
  const root = templateRoot(type.folder(device));
  const keep = new Set<string>();
  for (const path of wanted.keys()) for (let f = parentOf(path); f !== '/'; f = parentOf(f)) keep.add(f);
  const folders = new Set<string>();
  for (const path of leaving) {
    for (let f = parentOf(path); f !== '/' && f.startsWith(`${root === '/' ? '' : root}/`) && f !== root; f = parentOf(f)) {
      if (!keep.has(f)) folders.add(f);
    }
  }
  return [...folders].sort((a, b) => b.split('/').length - a.split('/').length);
}
