import type { MessageClient } from './rpc';
import type { Storage } from './storage';
import type { StorageApi } from './storageApi';

/** Bytes per chunk: 1 MiB, about 1.4 MB of base64 per bridge call. */
export const DEFAULT_CHUNK_SIZE = 1 << 20;

export function toBase64(bytes: Uint8Array): string {
  let binary = '';
  // String.fromCharCode takes its bytes as arguments, so go a slice at a time.
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

export function fromBase64(base64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** {@link Storage} kept by a remote implementation of {@link StorageApi}. */
export class RpcStorage implements Storage {
  constructor(
    private readonly api: MessageClient<StorageApi>['storage'],
    private readonly chunkSize = DEFAULT_CHUNK_SIZE,
  ) {}

  async readText(path: string) {
    return (await this.api.readText({ path })) ?? undefined;
  }

  async writeText(path: string, text: string) {
    await this.api.writeText({ path, text });
  }

  async appendText(path: string, text: string) {
    await this.api.appendText({ path, text });
  }

  async exists(path: string) {
    return this.api.exists({ path });
  }

  async readBlob(path: string) {
    const size = await this.api.size({ path });
    if (size === null) return undefined;
    const parts: Uint8Array<ArrayBuffer>[] = [];
    for (let offset = 0; offset < size; offset += this.chunkSize) {
      const length = Math.min(this.chunkSize, size - offset);
      parts.push(fromBase64(await this.api.readChunk({ path, offset, length })));
    }
    return new Blob(parts);
  }

  async writeBlob(path: string, blob: Blob) {
    // Always at least one chunk, so an empty blob still writes an empty file.
    for (let offset = 0; offset === 0 || offset < blob.size; offset += this.chunkSize) {
      const bytes = new Uint8Array(await blob.slice(offset, offset + this.chunkSize).arrayBuffer());
      await this.api.writeChunk({
        path,
        data: toBase64(bytes),
        first: offset === 0,
        last: offset + this.chunkSize >= blob.size,
      });
    }
  }
}
