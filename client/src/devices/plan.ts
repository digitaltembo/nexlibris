import type { Device, FileRef, Item, ItemId, Library, PlacedFile } from '@nexlibris/common';
import { matchItem } from './match';
import type { Catalog, ConnectionType, DeviceTarget, FilesType, RemoteBook, RemoteFile } from './types';
import { DEFAULT_FILE_NAME, expandPath, hasPlaceholders, templateRoot } from './pathTemplate';
import { catalogFiles, deviceItems, itemFiles } from './selection';

/** A file to put on the device. */
export interface Upload {
  path: string;
  item: Item;
  file: FileRef;
  /** Replacing a file a sync put there before, e.g. the book's newer file. */
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

/**
 * What a sync will do. It only ever adds: books in the catalog that aren't there are sent, files it
 * sent that the library has newer versions of are replaced (the old copy removed if the new one has
 * another name), and books moved where the templates now put them. Nothing else on the device is
 * touched: books no longer in the catalog stay, and a book deleted on the device is taken out of the
 * catalog rather than sent again.
 */
export interface SyncPlan {
  uploads: Upload[];
  /** Books moved to their new paths rather than sent again (when the device can move files). */
  moves: Move[];
  /** Copies found where their books go, recorded as the books' own. */
  kept: Kept[];
  /** Old copies of books sent again under a new name. */
  removals: string[];
  /** Records of files that are gone from the device, or were changed on it, so are no longer the sync's. */
  forget: string[];
  /** Books in the catalog whose files were deleted on the device: taken out of the catalog, not sent again. */
  deleted: ItemId[];
  conflicts: Conflict[];
  /** Items with no file in a format the device takes. */
  unsendable: ItemId[];
  /** Files already on the device as they should be. */
  unchanged: number;
  /** Files a sync put there whose books are no longer in the catalog: left as they are. */
  left: number;
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
  /**
   * Send only these books (each must be in the catalog), leaving the rest of the device as it is: no
   * other book is sent or moved, and the catalog isn't added. These are sent even if they were deleted there.
   */
  only?: ItemId[];
}

/** A file the plan wants on the device. */
export interface Wanted {
  item: Item;
  file: FileRef;
}

/** Whether a file on the device is as the plan wants it: the library's file it was sent (or taken) as. */
export const isCurrent = (placed: PlacedFile, wanted: Wanted) => placed.hash === wanted.file.hash;

/** What to send for an item: its file in the first of the type's formats it has, or the one chosen for it. */
export function chooseFile(item: Item, device: Device, type: ConnectionType): { file: FileRef } | undefined {
  const file = itemFiles(item, device, type)[0];
  return file && { file };
}

/** What should be on the device: a path for each file of each item in the catalog that goes there. */
export function desiredFiles(library: Library, device: Device, type: FilesType) {
  const files = new Map<string, Wanted>();
  const unsendable: ItemId[] = [];
  const pathOf = bookPaths(device, type);
  const chosen: Wanted[] = [];
  for (const { item, files: its } of catalogFiles(library, device, type, !!type.everyFormat)) {
    if (its.length) chosen.push(...its.map((file) => ({ item, file })));
    else unsendable.push(item.id);
  }
  // A file already on the device keeps its path while that's still its path (numbered as it was, if it was), or,
  // linked by hand, while it's current; one whose path has changed, by a new title or author or new templates,
  // goes to its new one. The rest are named around them. A book's newer file takes its old one's path.
  const placed = Object.entries(device.placed);
  const claimed = new Set<string>();
  const placedPath = (wanted: Wanted) => {
    const extension = extensionOf(type, wanted.file);
    const match =
      placed.find(([path, p]) => !claimed.has(path) && p.itemId === wanted.item.id && p.hash === wanted.file.hash) ??
      placed.find(([path, p]) => !claimed.has(path) && p.itemId === wanted.item.id && path.endsWith(`.${extension}`) && !chosen.some((w) => w.file.hash === p.hash && w.item.id === p.itemId));
    if (match) claimed.add(match[0]);
    return match?.[0];
  };
  const named = new Set<Wanted>();
  for (const wanted of chosen) {
    const path = placedPath(wanted);
    if (!path || files.has(path)) continue;
    const n = Number(/ \((\d+)\)(\.[a-z0-9]+)+$/i.exec(path)?.[1] ?? 1);
    // A file linked by hand stays where it was put while it's current.
    const linked = device.placed[path]!.linked && isCurrent(device.placed[path]!, wanted);
    if (linked || path === pathOf(wanted.item, wanted.file, n)) {
      files.set(path, wanted);
      named.add(wanted);
    }
  }
  for (const wanted of chosen) {
    if (named.has(wanted)) continue;
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
export function planSync(library: Library, device: Device, type: FilesType, listing: DeviceListing, options: PlanOptions = {}): SyncPlan {
  const { files: all, unsendable: allUnsendable } = desiredFiles(library, device, type);
  const only = options.only && new Set(options.only);
  const inScope = (itemId: ItemId) => !only || only.has(itemId);
  // Out of scope, a book's files are left as they are: neither wanted (which would send them) nor replaced.
  const files = only ? new Map([...all].filter(([, wanted]) => only.has(wanted.item.id))) : all;
  const unsendable = allUnsendable.filter(inScope);
  const inCatalog = new Set([...all.values()].map((w) => w.item.id));
  const sizes = new Map(listing.files.map((f) => [f.path, f.size]));
  const plan: SyncPlan = {
    uploads: [],
    moves: [],
    kept: [],
    removals: [],
    forget: [],
    deleted: [],
    conflicts: [],
    unsendable,
    unchanged: 0,
    left: 0,
    emptied: [],
  };
  const found = options.keepFound === false ? new Map<ItemId, RemoteBook[]>() : foundCopies(library, device, listing, all);
  /** A found copy of the wanted book that can be its file at `path`: there already, or (if the device can move files) anywhere. */
  const foundFor = (path: string, wanted: Wanted) => {
    const extension = path.slice(path.lastIndexOf('.'));
    const copies = (found.get(wanted.item.id) ?? []).filter((book) => book.path.toLowerCase().endsWith(extension.toLowerCase()));
    const copy = copies.find((book) => book.path === path) ?? (listing.canMove ? copies.find((book) => !all.has(book.path)) : undefined);
    if (!copy) return undefined;
    found.delete(wanted.item.id);
    const placed: PlacedFile = { itemId: wanted.item.id, hash: wanted.file.hash, size: copy.size, found: true };
    if (copy.path === path) plan.kept.push({ path, placed });
    else plan.moves.push({ from: copy.path, to: path, placed, found: true });
    return copy;
  };
  const upload = (path: string, wanted: Wanted, replaces: boolean) => plan.uploads.push({ path, ...wanted, replaces });
  /** Files a sync put there that nothing wants at their paths, but whose books are still in the catalog: old copies, replaced if a newer one is sent. */
  const stale: string[] = [];
  const deleted = new Set<ItemId>();

  for (const [path, placed] of Object.entries(device.placed)) {
    if (!inScope(placed.itemId)) continue;
    const size = sizes.get(path);
    const wanted = files.get(path);
    if (size === undefined) {
      // Deleted on the device. Sent alone, it's sent again; otherwise it's taken out of the catalog, for good.
      plan.forget.push(path);
      if (wanted && only) upload(path, wanted, false);
      else if (inCatalog.has(placed.itemId)) deleted.add(placed.itemId);
    } else if (size !== placed.size) {
      // Someone replaced it on the device; it's theirs now.
      plan.forget.push(path);
      if (wanted) plan.conflicts.push({ path, itemId: wanted.item.id, reason: 'It was changed on the device since it was sent.' });
    } else if (!wanted) {
      if (inCatalog.has(placed.itemId)) stale.push(path);
      else plan.left++;
    } else if (isCurrent(placed, wanted)) {
      plan.unchanged++;
    } else {
      upload(path, wanted, true);
    }
  }
  plan.deleted = [...deleted];
  for (const [path, wanted] of files) {
    if (deleted.has(wanted.item.id) && !only) continue;
    const there = device.placed[path];
    if (there && !inScope(there.itemId)) {
      // Another book's, which only a full sync moves out of the way.
      plan.conflicts.push({ path, itemId: wanted.item.id, reason: 'Another book is there until the next full sync.' });
      continue;
    }
    if (there) continue;
    if (sizes.has(path)) {
      if (!foundFor(path, wanted)) plan.conflicts.push({ path, itemId: wanted.item.id, reason: 'A file nexlibris didn’t send is already there.' });
    } else if (!foundFor(path, wanted)) {
      upload(path, wanted, false);
    }
  }
  // A book's file sent under a new name replaces its old copy; if the copy is as it should be, and the device can,
  // it's moved instead. Old copies nothing replaces stay.
  for (const u of [...plan.uploads]) {
    const old = stale.find((path) => device.placed[path]!.itemId === u.item.id);
    if (!old) continue;
    stale.splice(stale.indexOf(old), 1);
    const placed = device.placed[old]!;
    if (listing.canMove && isCurrent(placed, u)) {
      plan.moves.push({ from: old, to: u.path, placed });
      plan.uploads.splice(plan.uploads.indexOf(u), 1);
    } else {
      plan.removals.push(old);
      Object.assign(u, { replaces: true, supersedes: old });
    }
  }
  plan.left += stale.length;
  plan.emptied = emptiedFolders(device, type, [...plan.removals, ...plan.moves.map((m) => m.from)], all);
  const catalog = only ? undefined : type.catalog?.(device);
  if (catalog && listing.catalogs && !listing.catalogs.some((c) => sameUrl(c.url, catalog.url))) plan.catalog = catalog;
  return plan;
}

/**
 * Lists the folders a sync touches (where books go, by the library's books when it's given, and wherever
 * earlier syncs put files), and the catalogs.
 */
export async function listDevice(device: Device, type: FilesType, target: DeviceTarget, library?: Library): Promise<DeviceListing> {
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
export function syncFolders(device: Device, type: FilesType, library?: Library): Set<string> {
  const folders = new Set([templateRoot(type.folder(device)), ...Object.keys(device.placed).map(parentOf)]);
  if (library && hasPlaceholders(type.folder(device))) {
    for (const path of desiredFiles(library, device, type).files.keys()) folders.add(parentOf(path));
  }
  return folders;
}

/**
 * A device's book paths: the item's path by the type's templates, numbered ` (n)` as the nth book with
 * that path. A reader takes x4.epub as a plain EPUB, so the name doesn't say it's optimized, unless the
 * type keeps whole extensions (`fullExtension`).
 */
export function bookPaths(device: Device, type: FilesType) {
  const folder = type.folder(device);
  const fileName = type.fileName?.(device) ?? DEFAULT_FILE_NAME;
  return (item: Item, file: FileRef, n = 1) => expandPath(folder, fileName, item, extensionOf(type, file), n);
}

/** The extension a file gets on a device (see `FilesType.fullExtension`). */
export const extensionOf = (type: FilesType, file: FileRef) => (type.fullExtension ? file.format : file.format.split('.').pop()!);

/**
 * Folders that files are leaving (and their parents), below the template's fixed part and not
 * where wanted books go, deepest first: removed after a sync if empty.
 */
function emptiedFolders(device: Device, type: FilesType, leaving: string[], wanted: Map<string, unknown>): string[] {
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
