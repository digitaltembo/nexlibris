import {
  createItem,
  createMessageHandler,
  createSyncService,
  httpHubFiles,
  httpSyncClient,
  MemoryStorage,
  pairWithHub,
  previewSync,
  readPairings,
  runSync,
  storedFilePath,
  StoredLibraryBackend,
  syncApiMeta,
  type MessageImpl,
  type ScopeRule,
  type SyncApi,
} from '@nexlibris/common';
import { mkdtempSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { storeStream } from './importService';
import { createSyncHost, type SyncHost } from './syncHost';

const hosts: SyncHost[] = [];
afterEach(async () => {
  await Promise.all(hosts.splice(0).map((host) => host.stop()));
});

/** A hub: the host over HTTP on localhost, relaying to a library as the desktop's page would. */
async function hub(
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'nexlibris-sync-'))),
  file = join(dir, 'local', 'sync-host.json'),
  scope?: ScopeRule,
) {
  const backend = new StoredLibraryBackend(new MemoryStorage(), 'Desk');
  const service = createSyncService(backend, { name: () => 'Desk Mac', ...(scope && { scope }) });
  const impl: MessageImpl<SyncApi> = {
    sync: {
      ...service,
      pair: async () => Promise.reject(new Error('handled by the host')),
      done: async () => null,
      missing: async () => [],
    },
  };
  const handle = createMessageHandler(syncApiMeta, impl);
  let id = 0;
  const host = createSyncHost({
    file,
    libraryDir: dir,
    name: () => 'Desk Mac',
    relay: (request) => handle({ id: ++id, ...request }),
    host: '127.0.0.1',
    port: 0,
  });
  hosts.push(host);
  await host.setEnabled(true);
  const port = /:(\d+)$/.exec((await host.status()).addresses[0] ?? ':0')![1];
  // Listening on localhost here; the status lists LAN addresses, so take the port from it.
  return { backend, host, address: `http://127.0.0.1:${port}`, file, dir };
}

const client = (address: string, key?: string) => httpSyncClient(address, key);

describe('sync host', () => {
  it('pairs with a one-time code, then syncs over HTTP', async () => {
    const h = await hub();
    await h.backend.apply([{ type: 'addItem', item: createItem({ title: 'Dune' }) }]);
    const phone = new StoredLibraryBackend(new MemoryStorage(), 'Phone');
    await phone.apply([{ type: 'addItem', item: createItem({ title: 'Piranesi' }) }]);

    const { code } = await h.host.newCode({ keepFiles: 'tag:travel' });
    const pairing = await pairWithHub(phone, client(h.address), h.address, code.toLowerCase(), 'Pixel');
    expect(pairing.hub.name).toBe('Desk Mac');
    // The books chosen for the phone when the code was shown.
    expect(pairing.chosenFiles).toBe('tag:travel');
    // The code works once.
    await expect(pairWithHub(phone, client(h.address), h.address, code, 'Pixel')).rejects.toThrow(/expired/);

    const hubClient = client(h.address, pairing.key);
    const preview = await previewSync(phone, hubClient, pairing);
    await runSync(phone, hubClient, pairing, preview);
    const titles = Object.values((await h.backend.getLibrary()).items).map((i) => i.title).sort();
    expect(titles).toEqual(['Dune', 'Piranesi']);
    expect(Object.keys((await phone.getLibrary()).items)).toHaveLength(2);

    const status = await h.host.status();
    expect(status.peers).toEqual([
      expect.objectContaining({ origin: (await phone.getLibrary()).origin, name: 'Pixel', lastSyncedAt: expect.any(String) }),
    ]);
    // Keys are kept hashed.
    expect(readFileSync(h.file, 'utf8')).not.toContain(pairing.key);
    expect((await readPairings(phone))[0]!.base).toBeDefined();
  });

  it('shows a scoped phone only its books, as the paired phone whatever it says it is', async () => {
    const asked: string[] = [];
    const h = await hub(undefined, undefined, (_library, peer) => {
      asked.push(peer);
      return (item) => item.title === 'Dune';
    });
    await h.backend.apply(['Dune', 'Emma'].map((title) => ({ type: 'addItem' as const, item: createItem({ title }) })));
    const phone = new StoredLibraryBackend(new MemoryStorage(), 'Phone');
    const pairing = await pairWithHub(phone, client(h.address), h.address, (await h.host.newCode(null)).code, 'Pixel');
    const state = await client(h.address, pairing.key).state({ since: 0, peer: 'someone-else' });
    expect(state.scoped).toBe(true);
    expect(Object.values(state.library.items).map((i) => i.title)).toEqual(['Dune']);
    expect(state.changes).toHaveLength(1);
    expect(asked).toEqual([(await phone.getLibrary()).origin]);
  });

  it('refuses calls without a valid key, and withdraws a code after too many wrong guesses', async () => {
    const h = await hub();
    await expect(client(h.address).hello(null)).rejects.toThrow(/isn’t paired/);
    await expect(client(h.address, 'made-up').state({ since: 0 })).rejects.toThrow(/isn’t paired/);
    const { code } = await h.host.newCode();
    const phone = new StoredLibraryBackend(new MemoryStorage());
    for (let i = 0; i < 5; i++) {
      await expect(pairWithHub(phone, client(h.address), h.address, 'AAAA-AAAA', 'Pixel')).rejects.toThrow(/wrong/);
    }
    await expect(pairWithHub(phone, client(h.address), h.address, code, 'Pixel')).rejects.toThrow(/expired/);
  });

  it('keeps pairings across restarts, and forgets them when unpaired or turned off', async () => {
    const h = await hub();
    const phone = new StoredLibraryBackend(new MemoryStorage());
    await pairWithHub(phone, client(h.address), h.address, (await h.host.newCode()).code, 'Pixel');
    await h.host.stop();

    const again = createSyncHost({
      file: h.file,
      libraryDir: h.dir,
      name: () => 'Desk Mac',
      relay: async () => ({ ok: true, value: null }),
      host: '127.0.0.1',
      port: 0,
    });
    hosts.push(again);
    const status = await again.start();
    expect(status.enabled).toBe(true);
    expect(status.peers.map((p) => p.name)).toEqual(['Pixel']);
    expect((await again.unpair((await phone.getLibrary()).origin)).peers).toEqual([]);
    expect((await again.setEnabled(false)).addresses).toEqual([]);
    await expect(again.newCode()).rejects.toThrow(/Turn on/);
  });

  it('serves and stores files in the library folder, by hash', async () => {
    const h = await hub();
    // A file the desktop has, as its page would have stored it.
    const desk = await storeStream(h.dir, [Buffer.from('desk book')]);
    const phone = new StoredLibraryBackend(new MemoryStorage(), 'Phone');
    const mine = await phone.putFile(new Blob(['phone book']));
    const pairing = await pairWithHub(phone, client(h.address), h.address, (await h.host.newCode()).code, 'Pixel');
    const files = httpHubFiles(h.address, pairing.key, phone);

    expect(await files.missing([desk.hash, mine.hash])).toEqual([mine.hash]);
    await files.upload(mine.hash);
    expect(readFileSync(join(h.dir, storedFilePath(mine.hash)), 'utf8')).toBe('phone book');
    await files.download(desk.hash);
    expect(await (await phone.getFile(desk.hash))!.text()).toBe('desk book');
    expect(await files.missing([desk.hash, mine.hash])).toEqual([]);

    // Contents that don't match the hash are refused and not stored; a file it lacks is a 404; a key is needed.
    const wrong = 'a'.repeat(64);
    const put = await fetch(`${h.address}/api/sync/files/${wrong}`, { method: 'PUT', body: 'not that', headers: { Authorization: `Bearer ${pairing.key}` } });
    expect(put.status).toBe(400);
    expect(readdirSync(join(h.dir, 'files')).some((name) => name === 'aa')).toBe(false);
    await expect(files.download(wrong)).rejects.toThrow(/isn’t on this computer/);
    expect((await fetch(`${h.address}/api/sync/files/${desk.hash}`)).status).toBe(401);
  });
});
