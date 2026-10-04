/**
 * Folders remembered on this computer, by key: where each catalog connection is written
 * (`catalog:<id>`), and the sync folder of each pairing through one (`sync:<hub origin>`). Kept
 * in IndexedDB, as a folder handle can't go in the library: it belongs to this browser or app,
 * and isn't data. Using one needs permission again in each session, asked for on a click.
 */

declare global {
  interface FileSystemHandle {
    queryPermission?(options: { mode: 'read' | 'readwrite' }): Promise<PermissionState>;
    requestPermission?(options: { mode: 'read' | 'readwrite' }): Promise<PermissionState>;
  }
}

const DB = 'nexlibris-connections';
const STORE = 'catalog-folders';

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Couldn’t open the saved folders.'));
  });
}

async function run<T>(mode: IDBTransactionMode, work: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open();
  try {
    return await new Promise<T>((resolve, reject) => {
      const request = work(db.transaction(STORE, mode).objectStore(STORE));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error('Couldn’t read the saved folders.'));
    });
  } finally {
    db.close();
  }
}

/** The folder this connection was last written to here, if any (and if this browser keeps folders). */
export async function savedFolder(key: string): Promise<FileSystemDirectoryHandle | undefined> {
  if (typeof indexedDB === 'undefined') return undefined;
  try {
    return await run<FileSystemDirectoryHandle | undefined>('readonly', (store) => store.get(key));
  } catch {
    return undefined;
  }
}

export async function saveFolder(key: string, folder: FileSystemDirectoryHandle): Promise<void> {
  await run('readwrite', (store) => store.put(folder, key));
}

export async function forgetFolder(key: string): Promise<void> {
  if (typeof indexedDB === 'undefined') return;
  await run('readwrite', (store) => store.delete(key));
}

/** Whether we may write to the folder, asking if need be (which needs a click to be under way) unless `ask` is false. */
export async function mayWrite(folder: FileSystemDirectoryHandle, ask = true): Promise<boolean> {
  const options = { mode: 'readwrite' as const };
  if ((await folder.queryPermission?.(options)) === 'granted') return true;
  return ask && (await folder.requestPermission?.(options)) === 'granted';
}

/** Whether this browser can be given folders to use (Chrome, Edge, the desktop app). */
export const canUseFolders = () => typeof window !== 'undefined' && 'showDirectoryPicker' in window;
