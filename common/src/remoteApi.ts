import { post, type SimpleMeta } from 'estuary-rpc';

/**
 * Fetching from the web for the page, in the desktop app: OPDS catalogs being browsed (`client/src/
 * catalogs/`) and the books downloaded from them. A page can only read servers that allow it
 * (CORS), and many catalogs (and Project Gutenberg's book files) don't; the main process isn't
 * bound by that. Only http and https, only when the user browses or adds a book. Desktop only.
 */

export interface RemoteRequest {
  url: string;
  /** Request headers, e.g. `If-None-Match` to check a cached copy, or `Authorization` for a catalog that needs a sign-in. */
  headers?: Record<string, string>;
}

/** A small file (a cover) read whole, for a catalog whose images need a sign-in. */
export interface RemoteBytes {
  status: number;
  type?: string;
  /** Base64. */
  data: string;
}

export interface RemoteText {
  status: number;
  /** Where it ended up, after redirects. */
  url: string;
  text: string;
  etag?: string;
  lastModified?: string;
}

/** A file downloaded into the library's stored files (as the Import API stores picked files), for importing. */
export interface RemoteDownload {
  hash: string;
  size: number;
  /** Its name, from the server or the address. */
  name: string;
  type?: string;
}

export const remoteApiMeta = {
  remote: {
    fetchText: post<RemoteRequest, RemoteText, SimpleMeta>('api/remote/fetchText'),
    download: post<RemoteRequest, RemoteDownload, SimpleMeta>('api/remote/download'),
    fetchBytes: post<RemoteRequest, RemoteBytes, SimpleMeta>('api/remote/fetchBytes'),
  },
};

export type RemoteApi = typeof remoteApiMeta;
