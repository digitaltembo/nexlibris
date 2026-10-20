import type { LibraryBackend } from './backend';
import type { FileHash, Item, Library } from './types';

/**
 * Moving stored files between an instance and its hub after a sync (M6). Libraries refer to files
 * by hash, so this is just: send the hub what it lacks, then fetch what this instance lacks and
 * wants. Both sides store by hash, so an interrupted transfer simply carries on next time.
 *
 * Each side keeps covers, and books' files for the items its rule picks (all of them by default):
 * the hub takes what its `send` rule picks, and this instance fetches what its `keep` rule picks.
 * Other books' files stay where they are until wanted.
 */

/** The hub's files, as the instance syncing with it reaches them. */
export interface HubFiles {
  /** Which of these the hub doesn't have. */
  missing(hashes: FileHash[]): Promise<FileHash[]>;
  /** Fetches a file from the hub into this instance's storage. */
  download(hash: FileHash): Promise<void>;
  /** Sends a file stored here to the hub. */
  upload(hash: FileHash): Promise<void>;
  /**
   * Which of these files stored here to send. A hub that keeps every file takes whatever it
   * lacks (`missing`, the default); a folder passing files between devices takes only what
   * another device needs (`folderHub.ts`).
   */
  wanted?(hashes: FileHash[]): Promise<FileHash[]>;
  /** Called once the transfer is over, with every file this instance now holds. */
  finish?(held: FileHash[]): Promise<void>;
}

/** A file's path in the sync API: `GET` fetches it, `PUT` stores it. */
export const syncFileUrl = (hash: FileHash) => `api/sync/files/${hash}`;

export const isFileHash = (value: string) => /^[0-9a-f]{64}$/.test(value);

export interface FileProgress {
  direction: 'upload' | 'download';
  /** Files done so far in this direction, and how many there are. */
  done: number;
  total: number;
  /** Downloads: how many of them are books' files (the rest are covers), and how many books' files are left on the hub, not chosen for here. */
  books?: number;
  notKept?: number;
}

export interface FileTransferResult {
  uploaded: number;
  downloaded: number;
  /** Files that couldn't be moved, with why; the rest still were. */
  failed: { hash: FileHash; direction: 'upload' | 'download'; message: string }[];
  /** Books' files left on the hub, as the `keep` rule doesn't pick their items. */
  notKept: number;
  /** Books' files kept here and not sent, as the hub's `send` rule doesn't pick their items. */
  notSent: number;
  /**
   * Files wanted here that the hub doesn't have either: another instance has them and hasn't
   * synced since. They arrive on a later sync, once it has.
   */
  unavailable: number;
}

/** Every file a library refers to (or its items `among` picks): covers, and the files of each item. */
export function referencedFiles(library: Library, among?: (item: Item) => boolean): { covers: Set<FileHash>; books: Map<FileHash, Item[]> } {
  const covers = new Set<FileHash>();
  const books = new Map<FileHash, Item[]>();
  for (const item of Object.values(library.items)) {
    if (among && !among(item)) continue;
    if (item.cover) covers.add(item.cover.hash);
    for (const file of item.files) books.set(file.hash, [...(books.get(file.hash) ?? []), item]);
  }
  return { covers, books };
}

/**
 * After a sync: sends the hub what it lacks of covers and the files of items `send` picks, then
 * fetches covers and the files of items `keep` picks; of the items `among` picks, if given (those
 * both sides hold after the sync), as the hub has no others' and shouldn't get them.
 */
export async function transferFiles(
  local: LibraryBackend,
  hub: HubFiles,
  options: {
    keep?: (item: Item) => boolean;
    send?: (item: Item) => boolean;
    among?: (item: Item) => boolean;
    onProgress?: (progress: FileProgress) => void;
  } = {},
): Promise<FileTransferResult> {
  const { covers, books } = referencedFiles(await local.getLibrary(), options.among);
  const all = [...new Set([...covers, ...books.keys()])];
  const here = new Set<FileHash>();
  for (const hash of all) if (await local.hasFile(hash)) here.add(hash);
  const result: FileTransferResult = { uploaded: 0, downloaded: 0, failed: [], notKept: 0, notSent: 0, unavailable: 0 };

  const run = async (direction: 'upload' | 'download', hashes: FileHash[]) => {
    let done = 0;
    const counts = direction === 'download' ? { books: hashes.filter((hash) => books.has(hash)).length, notKept: result.notKept } : {};
    options.onProgress?.({ direction, done, total: hashes.length, ...counts });
    for (const hash of hashes) {
      try {
        await (direction === 'upload' ? hub.upload(hash) : hub.download(hash));
        result[direction === 'upload' ? 'uploaded' : 'downloaded']++;
      } catch (e) {
        result.failed.push({ hash, direction, message: e instanceof Error ? e.message : String(e) });
      }
      options.onProgress?.({ direction, done: ++done, total: hashes.length, ...counts });
    }
  };

  const send = options.send ?? (() => true);
  const sendable = [...here].filter((hash) => covers.has(hash) || books.get(hash)!.some(send));
  const held = [...here].filter((hash) => !covers.has(hash) && !books.get(hash)!.some(send));
  // Counted only where the hub lacks them: one it has already isn't being kept from it.
  if (held.length) result.notSent = (await hub.missing(held)).length;
  await run('upload', sendable.length ? await (hub.wanted ?? hub.missing).call(hub, sendable) : []);
  const keep = options.keep ?? (() => true);
  const wanted = all.filter((hash) => {
    if (here.has(hash)) return false;
    if (covers.has(hash) || books.get(hash)!.some(keep)) return true;
    result.notKept++;
    return false;
  });
  const lacking = new Set(wanted.length ? await hub.missing(wanted) : []);
  result.unavailable = lacking.size;
  const fetched = new Set(wanted.filter((hash) => !lacking.has(hash)));
  await run('download', [...fetched]);
  if (hub.finish) {
    const failed = new Set(result.failed.filter((f) => f.direction === 'download').map((f) => f.hash));
    await hub.finish([...here, ...[...fetched].filter((hash) => !failed.has(hash))]);
  }
  return result;
}

/**
 * The backend with files that aren't stored here fetched when they're read: `getFile` calls
 * `fetchMissing` for a file it lacks, which stores it if it can (and says so), then reads it again.
 * `fetchMissing` may throw to say why it couldn't. Reads of the same missing file share one fetch.
 */
export function fetchingMissingFiles(backend: LibraryBackend, fetchMissing: (hash: FileHash) => Promise<boolean>): LibraryBackend {
  const fetching = new Map<FileHash, Promise<boolean>>();
  return {
    getLibrary: () => backend.getLibrary(),
    apply: (ops, expectRevision) => backend.apply(ops, expectRevision),
    getChanges: (sinceRevision) => backend.getChanges(sinceRevision),
    putFile: (data) => backend.putFile(data),
    hasFile: (hash) => backend.hasFile(hash),
    deleteFile: (hash) => backend.deleteFile(hash),
    readLocalState: <T>(key: string) => backend.readLocalState<T>(key),
    writeLocalState: (key, value) => backend.writeLocalState(key, value),
    readLocalFile: (path) => backend.readLocalFile(path),
    writeLocalFile: (path, data) => backend.writeLocalFile(path, data),
    deleteLocalFile: (path) => backend.deleteLocalFile(path),
    async getFile(hash) {
      const blob = await backend.getFile(hash);
      if (blob) return blob;
      let fetch = fetching.get(hash);
      if (!fetch) {
        fetch = fetchMissing(hash).finally(() => fetching.delete(hash));
        fetching.set(hash, fetch);
      }
      return (await fetch) ? backend.getFile(hash) : undefined;
    },
  };
}
