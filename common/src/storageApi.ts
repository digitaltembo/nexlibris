import { get, post, type SimpleMeta } from 'estuary-rpc';

/**
 * File storage as an estuary-rpc API, for backends whose files live outside the
 * browser (the Android app's native storage). It mirrors {@link Storage}, except
 * that binary data moves in base64 chunks, since bridges like a WebView's
 * JavaScript interface only carry strings.
 *
 * Paths are slash-separated and relative to the library's root; implementations
 * must reject absolute paths and `..` segments.
 */

export interface PathRequest {
  path: string;
}

export interface TextRequest {
  path: string;
  text: string;
}

export interface ChunkReadRequest {
  path: string;
  offset: number;
  length: number;
}

export interface ChunkWriteRequest {
  path: string;
  /** Base64-encoded bytes. */
  data: string;
  /** Starts a new file, discarding any partial upload. */
  first: boolean;
  /** Ends the upload: the file replaces whatever was at `path`, all at once. */
  last: boolean;
}

/** The storage endpoints under `base` (`api/storage` for the library; the Android app serves the same for its sync folder). */
export const storageEndpoints = (base: string) => ({
  /** The file's text (UTF-8), or null if there's no file. */
  readText: get<PathRequest, string | null, SimpleMeta>(`${base}/readText`),
  /** Replaces the file, all at once. */
  writeText: post<TextRequest, null, SimpleMeta>(`${base}/writeText`),
  appendText: post<TextRequest, null, SimpleMeta>(`${base}/appendText`),
  exists: get<PathRequest, boolean, SimpleMeta>(`${base}/exists`),
  /** The file's size in bytes, or null if there's no file. */
  size: get<PathRequest, number | null, SimpleMeta>(`${base}/size`),
  /** Base64 of up to `length` bytes from `offset`. */
  readChunk: get<ChunkReadRequest, string, SimpleMeta>(`${base}/readChunk`),
  writeChunk: post<ChunkWriteRequest, null, SimpleMeta>(`${base}/writeChunk`),
  /** Deletes the file; nothing happens if there's none. */
  remove: post<PathRequest, null, SimpleMeta>(`${base}/remove`),
});

export const storageApiMeta = { storage: storageEndpoints('api/storage') };

export type StorageApi = typeof storageApiMeta;
