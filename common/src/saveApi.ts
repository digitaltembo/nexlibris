import { post, type SimpleMeta } from 'estuary-rpc';
import type { MessageClient } from './rpc';
import { DEFAULT_CHUNK_SIZE, toBase64 } from './rpcStorage';

/**
 * Saving a file out of the app, for platforms where a page can't download
 * (the Android WebView ignores `<a download>`). The file is uploaded in
 * chunks under a token, then `file` asks the user where to save it.
 */

export interface SaveChunkRequest {
  /** Names one upload: letters, digits and dashes. */
  token: string;
  /** Base64. */
  data: string;
  /** Starts the upload over, discarding anything sent under this token before. */
  first: boolean;
}

export interface SaveFileRequest {
  token: string;
  /** Suggested filename. */
  name: string;
  mimeType: string;
}

export const saveApiMeta = {
  save: {
    chunk: post<SaveChunkRequest, null, SimpleMeta>('api/save/chunk'),
    /** Resolves once the user has chosen: true if saved, false if they cancelled. */
    file: post<SaveFileRequest, boolean, SimpleMeta>('api/save/file'),
  },
};

export type SaveApi = typeof saveApiMeta;

/** A file as pieces in order: bytes, or Blobs (which can stay on disk until sent). */
export type FileParts = AsyncIterable<Uint8Array | Blob> | Iterable<Uint8Array | Blob>;

/**
 * Saves a file given as pieces through a remote {@link SaveApi}, so a large one is never all in
 * memory: pieces are gathered or cut into chunks of `chunkSize`. False if the user cancelled.
 */
export async function savePartsOverRpc(
  api: MessageClient<SaveApi>['save'],
  parts: FileParts,
  name: string,
  { mimeType = 'application/octet-stream', chunkSize = DEFAULT_CHUNK_SIZE, onProgress }: {
    mimeType?: string;
    chunkSize?: number;
    /** Called with the bytes sent so far. */
    onProgress?(bytes: number): void;
  } = {},
): Promise<boolean> {
  const token = crypto.randomUUID();
  let first = true;
  let sent = 0;
  let pending: Uint8Array[] = [];
  let pendingSize = 0;
  const flush = async () => {
    // An empty file still needs its first chunk, to start the upload.
    if (!pendingSize && !first) return;
    const chunk = new Uint8Array(pendingSize);
    let at = 0;
    for (const piece of pending) {
      chunk.set(piece, at);
      at += piece.length;
    }
    await api.chunk({ token, data: toBase64(chunk), first });
    first = false;
    onProgress?.((sent += pendingSize));
    pending = [];
    pendingSize = 0;
  };
  for await (const part of parts) {
    const size = part instanceof Blob ? part.size : part.length;
    for (let at = 0; at < size; ) {
      const take = Math.min(chunkSize - pendingSize, size - at);
      pending.push(
        part instanceof Blob ? new Uint8Array(await part.slice(at, at + take).arrayBuffer()) : part.subarray(at, at + take),
      );
      pendingSize += take;
      at += take;
      if (pendingSize >= chunkSize) await flush();
    }
  }
  await flush();
  return api.file({ token, name, mimeType });
}

/** Saves `blob` through a remote {@link SaveApi}; false if the user cancelled. */
export function saveOverRpc(
  api: MessageClient<SaveApi>['save'],
  blob: Blob,
  name: string,
  chunkSize = DEFAULT_CHUNK_SIZE,
): Promise<boolean> {
  return savePartsOverRpc(api, [blob], name, { mimeType: blob.type || undefined, chunkSize });
}
