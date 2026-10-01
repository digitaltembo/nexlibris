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

export const storageApiMeta = {
  storage: {
    /** The file's text (UTF-8), or null if there's no file. */
    readText: get<PathRequest, string | null, SimpleMeta>('api/storage/readText'),
    /** Replaces the file, all at once. */
    writeText: post<TextRequest, null, SimpleMeta>('api/storage/writeText'),
    appendText: post<TextRequest, null, SimpleMeta>('api/storage/appendText'),
    exists: get<PathRequest, boolean, SimpleMeta>('api/storage/exists'),
    /** The file's size in bytes, or null if there's no file. */
    size: get<PathRequest, number | null, SimpleMeta>('api/storage/size'),
    /** Base64 of up to `length` bytes from `offset`. */
    readChunk: get<ChunkReadRequest, string, SimpleMeta>('api/storage/readChunk'),
    writeChunk: post<ChunkWriteRequest, null, SimpleMeta>('api/storage/writeChunk'),
  },
};

export type StorageApi = typeof storageApiMeta;
