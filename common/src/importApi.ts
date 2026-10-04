import { post, type SimpleMeta } from 'estuary-rpc';
import type { FileHash } from './types';

/**
 * Picking files to import in the native apps, which copy them straight into the library's
 * stored files instead of handing them to the page: reading a picked file in the Android
 * WebView goes through the system's document provider and then back over the bridge as
 * base64, which made a 300 MB import take minutes. The page then reads each file from the
 * app's `/library/files/…` URL to parse it, and storing it again finds it already there.
 *
 * It takes two calls, so the page can show the copying's progress: `pick` shows the picker and
 * lists what was chosen, then `store` copies those files a batch at a time until it's done. The
 * app keeps the latest pick's list for `store`; the page stops calling to stop the copy.
 *
 * Files land where `StoredLibraryBackend` keeps them, at {@link storedFilePath}. A file that's
 * picked but then not imported (it can't be read, say) stays stored, unreferenced, as a
 * detached file does.
 */

export interface PickRequest {
  /** Formats to accept, by extension without the dot (`epub`, `x4.epub`); other files are skipped. */
  extensions: string[];
  /**
   * Pick a folder rather than files: the files in it and its subfolders are picked, apart from
   * hidden ones (named with a leading dot, as are hidden folders' contents).
   */
  folder?: boolean;
  /** Folder picks: other files to store and return, by name ignoring case (Calibre's `metadata.opf`, `cover.jpg`). */
  names?: string[];
}

/** A file chosen to import, before it's stored. */
export interface ChosenFile {
  name: string;
  /**
   * Folder picks: where the file is, `/`-separated, starting with the picked folder's name
   * (`Calibre Library/Frank Herbert/Dune (7)/Dune.epub`), as a browser's folder input gives it.
   */
  path?: string;
  /** In bytes, as the system reports it; 0 if it doesn't. */
  size: number;
}

export interface PickResult {
  /** Names this pick for `store`. */
  token: string;
  /** What to store, in order; empty if the user cancelled. */
  files: ChosenFile[];
  /** Files left out (other types); in a folder pick, `name` is the file's path. */
  skipped: Skipped[];
}

export interface Skipped {
  name: string;
  reason: string;
}

export interface StoreRequest {
  token: string;
  /** The index in the pick's `files` to start at: 0, then each result's `next`. */
  start: number;
}

/** A chosen file, stored. */
export interface PickedFile extends ChosenFile {
  /** SHA-256, lowercase hex, as `hashBlob` makes it. */
  hash: FileHash;
  /** As stored, which is what counts. */
  size: number;
}

export interface StoreResult {
  /** The batch's files that were stored. */
  files: PickedFile[];
  /** The batch's files that couldn't be read, with why (named by path in a folder pick). */
  skipped: Skipped[];
  /** Where the next batch starts; the pick's length once every file is done. */
  next: number;
}

/** A batch stops after this many files, or once it has copied this many bytes, whichever comes first. */
export const STORE_BATCH_FILES = 50;
export const STORE_BATCH_BYTES = 32 * 1024 * 1024;

export const importApiMeta = {
  import: {
    /** Shows the system's file (or folder) picker and lists what was chosen; nothing is stored yet. */
    pick: post<PickRequest, PickResult, SimpleMeta>('api/import/pick'),
    /** Stores the next batch of the latest pick's files. Fails if `token` isn't the latest pick's. */
    store: post<StoreRequest, StoreResult, SimpleMeta>('api/import/store'),
  },
};

export type ImportApi = typeof importApiMeta;

/** Where a stored file lives in library storage, by hash. Android and desktop store picked files here too. */
export const storedFilePath = (hash: FileHash) => `files/${hash.slice(0, 2)}/${hash}`;
