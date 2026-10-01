import { post, type SimpleMeta } from 'estuary-rpc';
import type { FileHash } from './types';

/**
 * Picking files to import in the native apps, which copy them straight into the library's
 * stored files instead of handing them to the page: reading a picked file in the Android
 * WebView goes through the system's document provider and then back over the bridge as
 * base64, which made a 300 MB import take minutes. The page then reads each file from the
 * app's `/library/files/…` URL to parse it, and storing it again finds it already there.
 *
 * Files land where `StoredLibraryBackend` keeps them, at {@link storedFilePath}. A file that's
 * picked but then not imported (it can't be read, say) stays stored, unreferenced, as a
 * detached file does.
 */

export interface PickRequest {
  /** Formats to accept, by extension without the dot (`epub`, `x4.epub`); other files are skipped. */
  extensions: string[];
}

export interface PickedFile {
  name: string;
  /** SHA-256, lowercase hex, as `hashBlob` makes it. */
  hash: FileHash;
  size: number;
}

export interface PickResult {
  files: PickedFile[];
  skipped: { name: string; reason: string }[];
}

export const importApiMeta = {
  import: {
    /** Shows the system's file picker; resolves once the chosen files are stored, empty if cancelled. */
    pick: post<PickRequest, PickResult, SimpleMeta>('api/import/pick'),
  },
};

export type ImportApi = typeof importApiMeta;

/** Where a stored file lives in library storage, by hash. Android and desktop store picked files here too. */
export const storedFilePath = (hash: FileHash) => `files/${hash.slice(0, 2)}/${hash}`;
