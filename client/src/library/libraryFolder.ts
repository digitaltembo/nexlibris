import {
  createMessageClient,
  libraryFolderApiMeta,
  LAYOUT_PATH,
  PLACED_PATH,
  PlacedLibraryBackend,
  readLayout,
  storageApiMeta,
  storedFilePath,
  StoredLibraryBackend,
  type FileHash,
  type FileLayout,
  type FolderChoice,
  type Library,
  type LibraryBackend,
  type LibraryFolderApi,
  type MessageClient,
  type RpcSend,
  type Storage,
} from '@nexlibris/common';
import { inAndroidApp } from '../backends/androidBridge';
import { inDesktopApp } from '../backends/desktopBridge';
import { NativeStorage } from '../backends/nativeStorage';
import { OpfsStorage } from '../backends/opfsStorage';
import { placeBooks } from './fileLayout';
import { forgetFolder, mayWrite, savedFolder, saveFolder } from './savedFolders';

/**
 * Where the library is kept, and moving it. By default, in the browser's own storage (OPFS) or
 * the desktop app's data folder; optionally, in a folder the user picks, with the books laid out
 * in it by path templates (`fileLayout.ts`, `common/src/placedLibrary.ts`). The browser keeps the
 * folder's handle (`savedFolders.ts`) and moves the library itself (`relocate`); the desktop app
 * keeps the folder's path, and its main process moves the library (`desktop/src/libraryFolder.ts`).
 * Android keeps the library in its own storage.
 */

export interface LibraryPlace {
  kind: 'browser' | 'app' | 'folder' | 'android';
  /** The folder's path in the desktop app, its name in a browser. */
  name?: string;
  /** In a folder: the library, whose layout can change. */
  placed?: PlacedLibraryBackend;
  /** In the desktop app: its main process's side. */
  desktop?: MessageClient<LibraryFolderApi>['libraryFolder'];
}

let current: LibraryPlace = { kind: 'browser' };

/** Where the open library is. */
export const libraryPlace = () => current;

/** Saved folders' key for the library's (`savedFolders.ts`). */
const LIBRARY_KEY = 'library';
const OPFS_LIBRARY = ['libraries', 'default'] as const;

/** The browser's library folder needs permission again, which takes a click. */
export class FolderPermissionNeeded extends Error {
  constructor(readonly folder: FileSystemDirectoryHandle) {
    super(`nexlibris keeps your library in the folder “${folder.name}”, and needs your permission to open it.`);
    this.name = 'FolderPermissionNeeded';
  }
}

/** The desktop app's library, in its data folder or a folder of the user's. */
export async function openDesktopLibrary(transport: RpcSend): Promise<LibraryBackend> {
  const client = createMessageClient({ ...storageApiMeta, ...libraryFolderApiMeta }, transport);
  const location = await client.libraryFolder.location(null);
  const storage = new NativeStorage(client.storage, undefined, { api: client.libraryFolder, placed: location.placed });
  if (!location.placed) {
    current = { kind: 'app', name: location.path, desktop: client.libraryFolder };
    return new StoredLibraryBackend(storage);
  }
  const placed = await PlacedLibraryBackend.open(storage, placeBooks);
  current = { kind: 'folder', name: location.path, placed, desktop: client.libraryFolder };
  return placed;
}

/** Android's library, in the app's storage. */
export function openAndroidLibrary(transport: RpcSend): LibraryBackend {
  const client = createMessageClient(storageApiMeta, transport);
  current = { kind: 'android' };
  return new StoredLibraryBackend(new NativeStorage(client.storage));
}

/** The browser's library: in the folder it was moved to, if any, else in the browser's own storage. */
export async function openBrowserLibrary(): Promise<LibraryBackend> {
  const folder = await savedFolder(LIBRARY_KEY);
  if (folder) {
    if (!(await mayWrite(folder, false))) throw new FolderPermissionNeeded(folder);
    const storage = OpfsStorage.at(folder);
    if (!(await readLayout(storage))) throw new Error(`The folder “${folder.name}” no longer has the library in it.`);
    const placed = await PlacedLibraryBackend.open(storage, placeBooks);
    current = { kind: 'folder', name: folder.name, placed };
    return placed;
  }
  if (!navigator.storage?.getDirectory) {
    throw new Error('This browser does not support the Origin Private File System, which nexlibris needs to store your library.');
  }
  current = { kind: 'browser' };
  return new StoredLibraryBackend(await OpfsStorage.open(...OPFS_LIBRARY));
}

/** Gives up on the browser's library folder, going back to the browser's storage (empty, if the library moved out of it). */
export const forgetLibraryFolder = () => forgetFolder(LIBRARY_KEY);

/** Whether the library can be kept in a folder here: in the desktop app, or a browser that can be given folders. */
export const canChooseLibraryFolder = () => !inAndroidApp() && (inDesktopApp() || 'showDirectoryPicker' in window);

const CHANNEL = 'nexlibris:library';

/** Tells the app's other tabs the library moved, so they open it where it is now. */
function announceMove() {
  if (typeof BroadcastChannel === 'undefined') return;
  const channel = new BroadcastChannel(CHANNEL);
  channel.postMessage('moved');
  channel.close();
}

/** Calls `onMoved` when another tab moves the library. Returns the way to stop. */
export function onLibraryMoved(onMoved: () => void): () => void {
  if (typeof BroadcastChannel === 'undefined') return () => undefined;
  const channel = new BroadcastChannel(CHANNEL);
  channel.onmessage = () => onMoved();
  return () => channel.close();
}

/** Storage that can list and delete whole folders, as moving a library needs. */
export interface Tree extends Storage {
  list(prefix: string): Promise<string[]>;
  removeTree(prefix: string): Promise<void>;
}

export interface Progress {
  done: number;
  total: number;
}

const DATA_PREFIX = '.nexlibris/';
const HASH = /^[0-9a-f]{64}$/;

/**
 * Moves a library from one storage to another (`from.placed`: laid out in a folder; else kept as
 * the browser's storage keeps it): its own files, and each stored book file to its place by
 * `to.layout` (`placed`), or into `files/` with the rest if it has none or something else is
 * there. Files are copied and checked, then the originals deleted; if anything fails, the copies
 * are deleted and the library is left where it was. Other files in the folders stay as they are.
 */
export async function relocate(
  from: { tree: Tree; placed: boolean },
  to: { tree: Tree; layout?: FileLayout },
  placed: ReadonlyMap<FileHash, string>,
  onProgress?: (progress: Progress) => void,
): Promise<void> {
  const fromData = from.placed ? DATA_PREFIX : '';
  const toData = to.layout ? DATA_PREFIX : '';
  if ((await to.tree.exists(`${toData}library.json`)) || (await readLayout(to.tree))) throw new Error('That folder has a library already.');

  const sources = new Map<FileHash, string>();
  if (from.placed) {
    const text = await from.tree.readText(PLACED_PATH);
    for (const [hash, path] of Object.entries(text ? (JSON.parse(text) as Record<FileHash, string>) : {})) {
      if (await from.tree.exists(path)) sources.set(hash, path);
    }
  }
  for (const path of await from.tree.list(`${fromData}files/`)) {
    const hash = path.slice(path.lastIndexOf('/') + 1);
    if (HASH.test(hash) && !sources.has(hash)) sources.set(hash, path);
  }

  const steps: { from: string; to: string }[] = [];
  const index: Record<FileHash, string> = {};
  const claimed = new Set<string>();
  for (const [hash, source] of sources) {
    const path = to.layout ? placed.get(hash) : undefined;
    if (path && !claimed.has(path.toLowerCase()) && !(await to.tree.exists(path))) {
      claimed.add(path.toLowerCase());
      index[hash] = path;
      steps.push({ from: source, to: path });
    } else {
      steps.push({ from: source, to: toData + storedFilePath(hash) });
    }
  }
  for (const name of ['library.json', 'changes.jsonl']) {
    if (await from.tree.exists(fromData + name)) steps.push({ from: fromData + name, to: toData + name });
  }
  for (const path of await from.tree.list(`${fromData}local/`)) steps.push({ from: path, to: toData + path.slice(fromData.length) });

  const written: string[] = [];
  try {
    for (const [i, step] of steps.entries()) {
      const data = await from.tree.readBlob(step.from);
      if (!data) throw new Error(`Couldn’t read ${step.from}.`);
      await to.tree.writeBlob(step.to, data);
      written.push(step.to);
      const copy = await to.tree.readBlob(step.to);
      if (copy?.size !== data.size) throw new Error(`${step.to} didn’t copy whole.`);
      onProgress?.({ done: i + 1, total: steps.length });
    }
    if (to.layout) {
      await to.tree.writeText(LAYOUT_PATH, JSON.stringify(to.layout));
      written.push(LAYOUT_PATH);
      await to.tree.writeText(PLACED_PATH, JSON.stringify(index));
      written.push(PLACED_PATH);
    }
  } catch (e) {
    for (const path of written) {
      await to.tree.remove(path).catch(() => undefined);
      await to.tree.prune?.(path).catch(() => undefined);
    }
    throw e;
  }

  // Copied and checked: the originals go.
  if (from.placed) {
    for (const step of steps) {
      if (step.from.startsWith(DATA_PREFIX)) continue;
      await from.tree.remove(step.from);
      await from.tree.prune?.(step.from);
    }
    await from.tree.removeTree(DATA_PREFIX);
  } else {
    await from.tree.removeTree('');
  }
}

/** Each stored book file's path by the layout. */
export const placesFor = (library: Library, layout: FileLayout) => placeBooks(library, layout, new Map());

/** What a folder picked in the browser holds already. */
export async function browserFolderHolds(folder: FileSystemDirectoryHandle): Promise<FolderChoice['holds']> {
  const tree = OpfsStorage.at(folder);
  if ((await readLayout(tree)) || (await tree.exists('library.json'))) return 'library';
  for await (const entry of folder.values()) if (!['.DS_Store', 'Thumbs.db', 'desktop.ini'].includes(entry.name)) return 'files';
  return 'nothing';
}

/** Opens the library already in a folder picked in the browser, leaving this one where it is. */
export async function openBrowserFolder(folder: FileSystemDirectoryHandle): Promise<void> {
  if (!(await mayWrite(folder))) throw new Error('nexlibris wasn’t given permission to use that folder.');
  await saveFolder(LIBRARY_KEY, folder);
  announceMove();
}

/**
 * Moves the browser's library into `to` (a folder picked with `showDirectoryPicker`, laid out by
 * `layout`), or back into the browser's storage if `to` isn't given. Afterwards the page opens it
 * there (reload).
 */
export async function moveBrowserLibrary(
  library: Library,
  to: { folder: FileSystemDirectoryHandle; layout: FileLayout } | undefined,
  onProgress?: (progress: Progress) => void,
): Promise<void> {
  const saved = current.kind === 'folder' ? await savedFolder(LIBRARY_KEY) : undefined;
  if (to && saved) {
    if (await saved.isSameEntry(to.folder)) throw new Error('The library is in that folder already.');
    if ((await saved.resolve(to.folder)) || (await to.folder.resolve(saved))) {
      throw new Error('The library can’t move into its own folder, or into one its folder is in.');
    }
  }
  if (to && !(await mayWrite(to.folder))) throw new Error('nexlibris wasn’t given permission to use that folder.');
  const source = saved ? { tree: OpfsStorage.at(saved), placed: true } : { tree: await OpfsStorage.open(...OPFS_LIBRARY), placed: false };
  const target = to ? { tree: OpfsStorage.at(to.folder), layout: to.layout } : { tree: await OpfsStorage.open(...OPFS_LIBRARY) };
  await relocate(source, target, to ? placesFor(library, to.layout) : new Map(), onProgress);
  if (to) await saveFolder(LIBRARY_KEY, to.folder);
  else await forgetFolder(LIBRARY_KEY);
  announceMove();
}

/** Whether the browser's storage has a library, when the open one is in a folder (one left there by opening another). */
export async function browserStorageHasLibrary(): Promise<boolean> {
  if (!navigator.storage?.getDirectory) return false;
  return (await OpfsStorage.open(...OPFS_LIBRARY)).exists('library.json');
}

/** Opens the library in the browser's storage, leaving the one in a folder where it is. */
export async function openBrowserStorage(): Promise<void> {
  await forgetFolder(LIBRARY_KEY);
  announceMove();
}
