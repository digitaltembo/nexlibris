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
  type MessageImpl,
  type RpcSend,
  type ServerApi,
  type SessionInfo,
  type Storage,
} from '@nexlibris/common';
import { cloudBackend, serverApi, serverSession, setWantsCloud } from './account';
import { itemFiles } from './freeFiles';
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
 * Android keeps the library in its own storage. A page from a nexlibris server (M4) can keep it
 * in the account signed in there instead (`cloud`), moving it there and back.
 */

export interface LibraryPlace {
  /** The browser's own storage, the app's own storage, a folder of the user's, or an account on the server the page came from. */
  kind: 'browser' | 'app' | 'folder' | 'cloud';
  /** In the desktop or Android app. */
  app?: 'desktop' | 'android';
  /** The folder's path in the desktop app, where it is on Android, its name in a browser; the account's name in the cloud. */
  name?: string;
  /** In a folder: the library, whose layout can change. */
  placed?: PlacedLibraryBackend;
  /** In the desktop or Android app: the app's side. */
  native?: MessageClient<LibraryFolderApi>['libraryFolder'];
  /** On Android: a folder the library was in that the app lost access to. */
  lost?: string;
}

let current: LibraryPlace = { kind: 'browser' };

/** Where the open library is. */
export const libraryPlace = () => current;

/**
 * Whether a book's files can be shown in the system's file manager: in the desktop app, whose
 * library is in a folder on disk. A browser can't show its folders (OPFS has none to show, and a
 * folder handle has no path), and Android's library is in the app's private storage.
 */
export const canShowFiles = () => current.app === 'desktop';

/** Shows a stored file in the system's file manager, selected (see {@link canShowFiles}). */
export async function showFileInFolder(hash: FileHash): Promise<void> {
  const { native, placed } = current;
  if (!native || current.app !== 'desktop') throw new Error('Files can only be shown in the desktop app.');
  const path = placed ? await placed.filePath(hash) : storedFilePath(hash);
  if (!path) throw new Error('The file isn’t stored on this computer.');
  await native.showFile({ path });
}

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

/** The desktop or Android app's library, in the app's own storage or a folder of the user's. */
export async function openNativeLibrary(transport: RpcSend, app: 'desktop' | 'android'): Promise<LibraryBackend> {
  const client = createMessageClient({ ...storageApiMeta, ...libraryFolderApiMeta }, transport);
  const location = await client.libraryFolder.location(null);
  const storage = new NativeStorage(client.storage, undefined, { api: client.libraryFolder, placed: location.placed });
  const lost = location.lost !== undefined ? { lost: location.lost } : {};
  if (!location.placed) {
    current = { kind: 'app', app, name: location.path, native: client.libraryFolder, ...lost };
    return new StoredLibraryBackend(storage);
  }
  const placed = await PlacedLibraryBackend.open(storage, placeBooks);
  current = { kind: 'folder', app, name: location.path, placed, native: client.libraryFolder };
  return placed;
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

/** The library is in an account on the server, and nobody's signed in (or the server can't be reached). */
export class SignInNeeded extends Error {
  constructor(readonly session: SessionInfo | undefined) {
    super(session ? 'Sign in to open your library.' : 'Your library is in your nexlibris account, and its server can’t be reached.');
    this.name = 'SignInNeeded';
  }
}

/** The library in the account signed in to this instance's server (`account.ts`). */
export async function openCloudLibrary(): Promise<LibraryBackend> {
  const session = await serverSession();
  if (!session?.account) throw new SignInNeeded(session);
  current = { kind: 'cloud', name: session.account.name };
  return cloudBackend();
}

/** Every file the library's books name (theirs and their covers'), once each. */
const libraryFiles = (library: Library) => [...new Set(Object.values(library.items).flatMap(itemFiles))];

/** An account's library, as moving one in and out needs it. */
export interface CloudAccount {
  backend: LibraryBackend;
  api: Pick<MessageImpl<ServerApi>['library'], 'status' | 'missing' | 'import' | 'remove'>;
}

const signedInAccount = (): CloudAccount => ({ backend: cloudBackend(), api: serverApi().library });

/** The account's files missing of these, asked a batch at a time. */
async function missingIn(account: CloudAccount, hashes: FileHash[]): Promise<Set<FileHash>> {
  const missing = new Set<FileHash>();
  for (let i = 0; i < hashes.length; i += 500) for (const hash of await account.api.missing({ hashes: hashes.slice(i, i + 500) })) missing.add(hash);
  return missing;
}

/**
 * Copies a library into an account that has none: the books' files stored here that it lacks,
 * checked there, then the library and its change log. Refused if the account has a library already.
 */
export async function copyToCloud(local: LibraryBackend, account: CloudAccount, onProgress?: (progress: Progress) => void): Promise<void> {
  if ((await account.api.status(null)).exists) throw new Error('Your account has a library already.');
  const library = await local.getLibrary();
  const here: FileHash[] = [];
  for (const hash of libraryFiles(library)) if (await local.hasFile(hash)) here.push(hash);
  const sending = [...(await missingIn(account, here))];
  for (const [i, hash] of sending.entries()) {
    const data = await local.getFile(hash);
    if (!data) throw new Error(`Couldn’t read the file ${hash.slice(0, 12)}….`);
    await account.backend.putFile(data);
    onProgress?.({ done: i + 1, total: sending.length });
  }
  if ((await missingIn(account, here)).size) throw new Error('Some files didn’t reach your account. Try again.');
  await account.api.import({ library, changes: await local.getChanges(0) });
}

/**
 * Copies an account's library into `storage`, which must have none: its files, then its change log
 * and the library. If anything fails, what was copied is deleted again.
 */
export async function copyFromCloud(account: CloudAccount, storage: Tree, onProgress?: (progress: Progress) => void): Promise<void> {
  if (await storage.exists('library.json')) throw new Error('This browser has a library of its own already. Open that one, or move it elsewhere first.');
  const library = await account.backend.getLibrary();
  const changes = await account.backend.getChanges(0);
  const local = new StoredLibraryBackend(storage);
  const hashes = libraryFiles(library);
  try {
    for (const [i, hash] of hashes.entries()) {
      const data = await account.backend.getFile(hash);
      if (data && (await local.putFile(data)).hash !== hash) throw new Error(`The file ${hash.slice(0, 12)}… arrived changed.`);
      onProgress?.({ done: i + 1, total: hashes.length });
    }
    await storage.writeText('changes.jsonl', changes.map((change) => JSON.stringify(change) + '\n').join(''));
    await storage.writeText('library.json', JSON.stringify(library));
  } catch (e) {
    await storage.removeTree('').catch(() => undefined);
    throw e;
  }
}

/**
 * Moves the library in this browser's storage to the signed-in account (`copyToCloud`), then
 * deletes the browser's copy, and the page opens the account's (reload). This instance's own state
 * (sync pairings, the text index, thumbnails) stays behind; the index and thumbnails are made again.
 */
export async function moveToCloud(backend: LibraryBackend, onProgress?: (progress: Progress) => void): Promise<void> {
  if (current.kind !== 'browser') throw new Error('Move the library back into this browser’s storage first.');
  await copyToCloud(backend, signedInAccount(), onProgress);
  // In the account and checked: the browser's copy goes.
  await (await OpfsStorage.open(...OPFS_LIBRARY)).removeTree('');
  setWantsCloud(true);
  announceMove();
}

/** Moves the account's library into this browser's storage (`copyFromCloud`), then deletes it from the account. Afterwards the page opens it here (reload). */
export async function moveFromCloud(onProgress?: (progress: Progress) => void): Promise<void> {
  const account = signedInAccount();
  await copyFromCloud(account, await OpfsStorage.open(...OPFS_LIBRARY), onProgress);
  await account.api.remove(null);
  setWantsCloud(false);
  announceMove();
}

/**
 * In the apps: copies this device's library to the signed-in account (`copyToCloud`), whose library
 * the app opens from then on (reload). The device's own library stays where it is, to open again
 * (`openDeviceLibrary`): a folder of the user's isn't the app's to delete.
 */
export async function copyAppLibraryToCloud(backend: LibraryBackend, onProgress?: (progress: Progress) => void): Promise<void> {
  if (!current.native) throw new Error('Only the apps keep their library this way.');
  await copyToCloud(backend, signedInAccount(), onProgress);
  setWantsCloud(true);
}

/** In the apps: opens the device's own library again rather than the account's (reload). */
export function openDeviceLibrary(): void {
  setWantsCloud(false);
}

/** Opens the library in the account, leaving this browser's where it is. */
export function openCloud(): void {
  setWantsCloud(true);
  announceMove();
}

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

/** Whether the browser's storage has a library, when the open one is in a folder or the account (one left there by opening another). */
export async function browserStorageHasLibrary(): Promise<boolean> {
  if (!navigator.storage?.getDirectory) return false;
  return (await OpfsStorage.open(...OPFS_LIBRARY)).exists('library.json');
}

/** Opens the library in the browser's storage, leaving the one in a folder (or the account) where it is. */
export async function openBrowserStorage(): Promise<void> {
  await forgetFolder(LIBRARY_KEY);
  setWantsCloud(false);
  announceMove();
}
