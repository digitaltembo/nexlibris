import { afterEach, describe, expect, it } from 'vitest';
import { StoredLibraryBackend } from './backend';
import { createItem } from './operations';
import { createMessageClient, createMessageHandler, type MessageImpl, type RpcMessage, type RpcResponse } from './rpc';
import { fromBase64, RpcStorage, toBase64 } from './rpcStorage';
import { saveApiMeta, saveOverRpc, savePartsOverRpc } from './saveApi';
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

describe('saveOverRpc', () => {
  it('uploads in chunks under one token, then asks to save with the name and type', async () => {
    const calls: { url: string; body: Record<string, unknown> }[] = [];
    const client = createMessageClient(saveApiMeta, async ({ url, body }) => {
      calls.push({ url, body: body as Record<string, unknown> });
      return url === 'api/save/file' ? true : null;
    });
    const blob = new Blob([new Uint8Array(2500).fill(7)], { type: 'application/zip' });
    expect(await saveOverRpc(client.save, blob, 'backup.zip', 1000)).toBe(true);

    const chunks = calls.filter((c) => c.url === 'api/save/chunk');
    expect(chunks.map((c) => c.body.first)).toEqual([true, false, false]);
    expect(new Set(calls.map((c) => c.body.token)).size).toBe(1);
    expect(chunks.reduce((n, c) => n + fromBase64(c.body.data as string).length, 0)).toBe(2500);
    expect(calls.at(-1)).toMatchObject({ url: 'api/save/file', body: { name: 'backup.zip', mimeType: 'application/zip' } });
  });

  it('sends a file given in pieces as whole chunks, in order, reporting progress', async () => {
    const chunks: Uint8Array[] = [];
    const client = createMessageClient(saveApiMeta, async ({ url, body }) => {
      if (url === 'api/save/chunk') chunks.push(fromBase64((body as { data: string }).data));
      return url === 'api/save/file' ? true : null;
    });
    const bytes = Uint8Array.from({ length: 2600 }, (_, i) => i % 251);
    // Small header-like pieces and Blobs of various sizes, as a zip arrives.
    async function* parts() {
      yield bytes.subarray(0, 30);
      yield new Blob([bytes.subarray(30, 1530)]);
      yield bytes.subarray(1530, 1560);
      yield new Blob([]);
      yield new Blob([bytes.subarray(1560, 2600)]);
    }
    const progress: number[] = [];
    expect(await savePartsOverRpc(client.save, parts(), 'big.zip', { chunkSize: 1000, onProgress: (n) => progress.push(n) })).toBe(true);
    expect(chunks.map((c) => c.length)).toEqual([1000, 1000, 600]);
    expect(new Uint8Array(chunks.flatMap((c) => [...c]))).toEqual(bytes);
    expect(progress).toEqual([1000, 2000, 2600]);

    chunks.length = 0;
    expect(await savePartsOverRpc(client.save, [], 'empty.txt')).toBe(true);
    expect(chunks.map((c) => c.length)).toEqual([0]);
  });
});

describe('base64', () => {
  const bytes = Uint8Array.from({ length: 70_000 }, (_, i) => (i * 37) % 256);
  // The slow, obvious way, to check the others against.
  const plain = (b: Uint8Array) => btoa(Array.from(b, (c) => String.fromCharCode(c)).join(''));
  const expected = plain(bytes);
  const proto = Uint8Array.prototype as { toBase64?: () => string };
  const ctor = Uint8Array as { fromBase64?: (s: string) => Uint8Array };
  const before = { toBase64: proto.toBase64, fromBase64: ctor.fromBase64 };
  afterEach(() => {
    proto.toBase64 = before.toBase64;
    ctor.fromBase64 = before.fromBase64;
  });

  it('round-trips without the native methods', () => {
    delete proto.toBase64;
    delete ctor.fromBase64;
    expect(toBase64(bytes)).toBe(expected);
    expect(fromBase64(expected)).toEqual(bytes);
  });

  it('uses the native methods where the runtime has them', () => {
    proto.toBase64 = function (this: Uint8Array) {
      return `native:${plain(this)}`;
    };
    ctor.fromBase64 = () => Uint8Array.of(42);
    expect(toBase64(bytes)).toBe(`native:${expected}`);
    expect(fromBase64(expected)).toEqual(Uint8Array.of(42));
  });
});
