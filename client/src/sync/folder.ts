import {
  createMessageClient,
  openFolderHub,
  RpcStorage,
  usbFolderApiMeta,
  type FolderCopy,
  type FolderHub,
  type FolderStorage,
} from '@nexlibris/common';
import { androidTransport, inAndroidApp } from '../backends/androidBridge';
import { OpfsStorage } from '../backends/opfsStorage';
import { canUseFolders, mayWrite, savedFolder } from '../library/savedFolders';

/**
 * Sync through a shared folder (see `common/src/folderHub.ts`). In the Android app it's a folder
 * in the phone's shared storage that the user picks (say `Documents/nexlibris-sync`), which a
 * computer sees when the phone is plugged in by USB; in a browser or the desktop app, a folder the
 * user picks: that one on the plugged-in phone, or any other both devices reach.
 */

/** Pairings through a folder have addresses `folder:<what to call it>`. */
export const FOLDER_PREFIX = 'folder:';
export const isFolderAddress = (address: string) => address.startsWith(FOLDER_PREFIX);
/** Where the folder's handle is remembered on this computer. */
export const folderKey = (hubOrigin: string) => `sync:${hubOrigin}`;

/** `FolderStorage` over a folder the user picked. */
export class HandleStorage extends OpfsStorage implements FolderStorage {
  constructor(root: FileSystemDirectoryHandle) {
    super(root);
  }

  async list(dir: string): Promise<string[]> {
    let folder = this.root;
    try {
      for (const part of dir.split('/')) folder = await folder.getDirectoryHandle(part);
    } catch {
      return [];
    }
    const names: string[] = [];
    for await (const name of (folder as unknown as { keys(): AsyncIterable<string> }).keys()) if (!name.startsWith('.')) names.push(name);
    return names;
  }
}

const usbFolder = () => createMessageClient(usbFolderApiMeta, androidTransport()).usbFolder;

/** The Android app's sync folder, as storage, and copying stored files in and out of it natively. */
function androidFolder(): { storage: FolderStorage; copy: FolderCopy } {
  const api = usbFolder();
  const storage = Object.assign(new RpcStorage(api), {
    list: (dir: string) => api.list({ path: dir }),
  });
  return {
    storage,
    copy: {
      toFolder: async (hash) => void (await api.toFolder({ hash })),
      fromFolder: async (hash) => void (await api.fromFolder({ hash })),
    },
  };
}

/** Where the Android app's sync folder is, as a computer browsing the phone sees it; null before one is chosen. */
export const androidFolderPath = async () => (await usbFolder().info(null)).path;

/** Asks for the Android app's sync folder (the system's folder picker); returns where it is. */
export const chooseAndroidFolder = async () => (await usbFolder().choose(null)).path;

/** Whether this instance can sync through a folder. */
export const canSyncThroughFolder = () => inAndroidApp() || canUseFolders();

export interface OpenFolder {
  hub: FolderHub;
  copy?: FolderCopy;
  /** The picked folder (browsers and the desktop app), to remember once paired. */
  handle?: FileSystemDirectoryHandle;
}

/** Opens the Android app's folder, or one the user picked. */
export function openFolder(handle?: FileSystemDirectoryHandle): OpenFolder {
  if (inAndroidApp()) {
    const { storage, copy } = androidFolder();
    return { hub: openFolderHub(storage, { name: 'Sync folder' }), copy };
  }
  if (!handle) throw new Error('Choose the folder first.');
  return { hub: openFolderHub(new HandleStorage(handle), { name: handle.name }), handle };
}

/** Asks for a folder to sync through (needs a click to be under way). Undefined if cancelled. */
export async function chooseFolder(): Promise<FileSystemDirectoryHandle | undefined> {
  try {
    return await window.showDirectoryPicker!({ id: 'sync-folder', mode: 'readwrite' });
  } catch {
    return undefined;
  }
}

/**
 * The folder a pairing syncs through: the app's own on Android, else the one remembered here,
 * once allowed to use it this session. Asking for that needs a click under way, so it's only
 * asked when `interactive`.
 */
export async function pairedFolder(hubOrigin: string, interactive: boolean): Promise<OpenFolder> {
  if (inAndroidApp()) return openFolder();
  const handle = await savedFolder(folderKey(hubOrigin));
  if (!handle) throw new Error('This computer doesn’t remember the sync folder. Pair with it again.');
  if (!(await mayWrite(handle, interactive))) {
    throw new Error(interactive ? `nexlibris wasn’t allowed to use the folder “${handle.name}”.` : 'Sync with the folder first.');
  }
  return openFolder(handle);
}
