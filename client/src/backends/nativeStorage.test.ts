import type { MessageClient, StorageApi } from '@nexlibris/common';
import { describe, expect, it } from 'vitest';
import { NativeStorage } from './nativeStorage';

describe('NativeStorage', () => {
  const bridged: string[] = [];
  const api = {
    size: async ({ path }: { path: string }) => (bridged.push(path), 4),
    readChunk: async () => btoa('json'),
  } as unknown as MessageClient<StorageApi>['storage'];
  const served: Record<string, string> = { '/library/files/ab/abcd': 'book', '/library/local/thumbs/ab/abcd.jpg': 'thumb' };
  const fetchFile = (async (url: string) =>
    url in served ? new Response(served[url]) : new Response('', { status: 404 })) as typeof fetch;
  const storage = new NativeStorage(api, fetchFile);

  it('fetches stored files and thumbnails from the app, and reads everything else over the bridge', async () => {
    expect(await (await storage.readBlob('files/ab/abcd'))?.text()).toBe('book');
    expect(await storage.readBlob('files/ab/missing')).toBeUndefined();
    expect(await (await storage.readBlob('local/thumbs/ab/abcd.jpg'))?.text()).toBe('thumb');
    expect(bridged).toEqual([]);
    expect(await (await storage.readBlob('library.json'))?.text()).toBe('json');
    expect(bridged).toEqual(['library.json']);
  });

  it('reports other failures', async () => {
    const failing = new NativeStorage(api, (async () => new Response('', { status: 500, statusText: 'Oops' })) as typeof fetch);
    await expect(failing.readBlob('files/ab/abcd')).rejects.toThrow('500 Oops');
  });
});
