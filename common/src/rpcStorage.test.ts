import { describe, expect, it } from 'vitest';
import { StoredLibraryBackend } from './backend';
import { createItem } from './operations';
import { createMessageClient, createMessageHandler, type MessageImpl, type RpcMessage, type RpcResponse } from './rpc';
import { fromBase64, RpcStorage, toBase64 } from './rpcStorage';
import { storageApiMeta, type StorageApi } from './storageApi';

/** A reference implementation of the storage API, with the semantics the native one must match. */
function memoryStorageService(): MessageImpl<StorageApi> {
  const files = new Map<string, Uint8Array>();
  const uploads = new Map<string, Uint8Array[]>();
  const check = (path: string) => {
    if (path.startsWith('/') || path.split('/').some((s) => s === '..' || s === '')) throw new Error(`Bad path: ${path}`);
    return path;
  };
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const concat = (parts: Uint8Array[]) => {
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let offset = 0;
    for (const part of parts) {
      out.set(part, offset);
      offset += part.length;
    }
    return out;
  };
  return {
    storage: {
      readText: async ({ path }) => {
        const file = files.get(check(path));
        return file ? decoder.decode(file) : null;
      },
      writeText: async ({ path, text }) => (files.set(check(path), encoder.encode(text)), null),
      appendText: async ({ path, text }) => {
        files.set(check(path), concat([files.get(path) ?? new Uint8Array(), encoder.encode(text)]));
        return null;
      },
      exists: async ({ path }) => files.has(check(path)),
      size: async ({ path }) => files.get(check(path))?.length ?? null,
      readChunk: async ({ path, offset, length }) => {
        const file = files.get(check(path));
        if (!file) throw new Error(`No file: ${path}`);
        return toBase64(file.subarray(offset, offset + length));
      },
      writeChunk: async ({ path, data, first, last }) => {
        check(path);
        if (first) uploads.set(path, []);
        const parts = uploads.get(path);
        if (!parts) throw new Error(`No upload in progress: ${path}`);
        parts.push(fromBase64(data));
        if (last) {
          files.set(path, concat(parts));
          uploads.delete(path);
        }
        return null;
      },
    },
  };
}

/** Connects a client to a handler the way a bridge does: as JSON strings, asynchronously. */
function bridge() {
  const handle = createMessageHandler(storageApiMeta, memoryStorageService());
  const calls: RpcMessage[] = [];
  let id = 0;
  const client = createMessageClient(storageApiMeta, async (request) => {
    const message = JSON.parse(JSON.stringify({ id: ++id, ...request })) as RpcMessage;
    calls.push(message);
    const response = JSON.parse(JSON.stringify(await handle(message))) as RpcResponse;
    if (!response.ok) throw new Error(response.message);
    return response.value;
  });
  return { client, calls };
}

describe('RpcStorage', () => {
  it('sends estuary-rpc requests by URL', async () => {
    const { client, calls } = bridge();
    await new RpcStorage(client.storage).writeText('library.json', '{}');
    expect(calls).toEqual([
      { id: 1, method: 'POST', url: 'api/storage/writeText', body: { path: 'library.json', text: '{}' } },
    ]);
  });

  it('reads, writes and appends text', async () => {
    const storage = new RpcStorage(bridge().client.storage);
    expect(await storage.readText('a.txt')).toBeUndefined();
    expect(await storage.exists('a.txt')).toBe(false);
    await storage.writeText('a.txt', 'héllo');
    await storage.appendText('a.txt', ' wörld\n');
    await storage.appendText('log/new.jsonl', 'x');
    expect(await storage.readText('a.txt')).toBe('héllo wörld\n');
    expect(await storage.readText('log/new.jsonl')).toBe('x');
    expect(await storage.exists('a.txt')).toBe(true);
  });

  it('moves blobs in chunks, byte for byte', async () => {
    const { client, calls } = bridge();
    const storage = new RpcStorage(client.storage, 1000);
    const bytes = Uint8Array.from({ length: 2500 }, (_, i) => (i * 7) % 256);
    await storage.writeBlob('files/ab/abc', new Blob([bytes]));
    expect(calls.map((c) => [c.url, (c.body as { first?: boolean }).first, (c.body as { last?: boolean }).last])).toEqual([
      ['api/storage/writeChunk', true, false],
      ['api/storage/writeChunk', false, false],
      ['api/storage/writeChunk', false, true],
    ]);
    const read = await storage.readBlob('files/ab/abc');
    expect(new Uint8Array(await read!.arrayBuffer())).toEqual(bytes);
    expect(await storage.readBlob('files/missing')).toBeUndefined();

    await storage.writeBlob('empty', new Blob([]));
    expect((await storage.readBlob('empty'))?.size).toBe(0);
  });

  it('surfaces errors from the other side', async () => {
    const storage = new RpcStorage(bridge().client.storage);
    await expect(storage.readText('../outside')).rejects.toThrow('Bad path');
  });

  it('can hold a whole library', async () => {
    const backend = new StoredLibraryBackend(new RpcStorage(bridge().client.storage, 64));
    const item = createItem({ title: 'Dune' });
    await backend.apply([{ type: 'addItem', item }]);
    const ref = await backend.putFile(new Blob(['x'.repeat(200)]));
    expect((await backend.getLibrary()).items[item.id]?.title).toBe('Dune');
    expect(await (await backend.getFile(ref.hash))?.text()).toBe('x'.repeat(200));
  });
});
