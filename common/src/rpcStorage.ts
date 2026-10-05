import type { MessageClient } from './rpc';
import type { Storage } from './storage';
import type { StorageApi } from './storageApi';

/** Bytes per chunk: 1 MiB, about 1.4 MB of base64 per bridge call. */
export const DEFAULT_CHUNK_SIZE = 1 << 20;

/** Native base64 (`Uint8Array.prototype.toBase64` and `Uint8Array.fromBase64`), where the runtime has it. */
interface NativeBase64 {
  toBase64?(this: Uint8Array): string;
}
interface NativeFromBase64 {
  fromBase64?(base64: string): Uint8Array<ArrayBuffer>;
}

export function toBase64(bytes: Uint8Array): string {
  // The native version is two orders of magnitude faster, which matters for whole books over the Android bridge.
  const native = (bytes as NativeBase64).toBase64;
  if (native) return native.call(bytes);
  let binary = '';
  // String.fromCharCode takes its bytes as arguments, so go a slice at a time. `apply` is much faster than spreading.
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000) as unknown as number[]);
  }
  return btoa(binary);
}

export function fromBase64(base64: string): Uint8Array<ArrayBuffer> {
  const native = (Uint8Array as NativeFromBase64).fromBase64;
  if (native) return native(base64);
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

  async remove(path: string) {
    await this.api.remove({ path });
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
