import { describe, expect, it } from 'vitest';
import { StoredLibraryBackend } from './backend';
import { createItem } from './operations';
import { stateDigest } from './repair';
import { MemoryStorage } from './storage';
import { pairWithHub, previewSync, readPairings, runSync } from './sync';
import { syncApiMeta } from './syncApi';
import { transferFiles } from './syncFiles';
import { createSyncHub } from './syncHub';
import { httpHubFiles, httpSend } from './syncHttp';
import { decodeMessage, encodeMessage, messageFetch, type SyncMessageRequest } from './syncMessage';
import { createMessageClient } from './rpc';

/** A hub reached as over Bluetooth: each call a message to `createSyncHub`'s `handle`. */
function setup() {
  let clock = Date.parse('2026-10-02T10:00:00Z');
  const phone = new StoredLibraryBackend(new MemoryStorage(), 'Phone');
  const browser = new StoredLibraryBackend(new MemoryStorage(), 'Browser');
  const hub = createSyncHub(phone, { name: () => 'Pixel', now: () => new Date(clock) });
  const fetchOver = messageFetch(async (message) => {
    const { header, body } = decodeMessage<SyncMessageRequest>(message);
    const response = await hub.handle({ ...header, body });
    return encodeMessage({ status: response.status }, response.body);
  });
  const ADDRESS = 'bluetooth://hub';
  const client = (key?: string) => createMessageClient(syncApiMeta, httpSend(ADDRESS, key, fetchOver)).sync;
  return { phone, browser, hub, fetchOver, client, ADDRESS, advance: (ms: number) => (clock += ms) };
}

describe('sync hub', () => {
  it('pairs with a one-time code, then syncs a library and its files', async () => {
    const { phone, browser, hub, fetchOver, client, ADDRESS } = setup();
    const { hash, size } = await phone.putFile(new Blob(['book']));
    await phone.apply([{ type: 'addItem', item: createItem({ title: 'On the phone', files: [{ hash, size, format: 'epub' }] }) }]);
    await browser.apply([{ type: 'addItem', item: createItem({ title: 'In the browser' }) }]);

    await expect(pairWithHub(browser, client(), ADDRESS, 'AAAA-AAAA', 'Chrome')).rejects.toThrow(/expired/);
    const { code } = hub.newCode({ keepFiles: ' tag:travel ' });
    const pairing = await pairWithHub(browser, client(), ADDRESS, code.toLowerCase(), 'Chrome');
    expect(pairing.hub.name).toBe('Pixel');
    // The hub's choice of books comes back with the pairing, but isn't saved with it.
    expect(pairing.chosenFiles).toBe('tag:travel');
    expect((await readPairings(browser))[0]).not.toHaveProperty('chosenFiles');
    // Used up.
    await expect(pairWithHub(browser, client(), ADDRESS, code, 'Chrome')).rejects.toThrow(/expired/);
    expect((await hub.peers()).map((peer) => peer.name)).toEqual(['Chrome']);

    const preview = await previewSync(browser, client(pairing.key), pairing);
    const result = await runSync(browser, client(pairing.key), pairing, preview);
    expect(result).toMatchObject({ received: 1, sent: 1 });
    expect(stateDigest(await browser.getLibrary()).hash).toBe(stateDigest(await phone.getLibrary()).hash);
    expect((await hub.peers())[0]!.lastSyncedAt).toBeDefined();

    const files = await transferFiles(browser, httpHubFiles(ADDRESS, pairing.key, browser, fetchOver));
    expect(files).toMatchObject({ downloaded: 1, failed: [] });
    expect(await (await browser.getFile(hash))!.text()).toBe('book');
    expect((await readPairings(browser))[0]!.base).toBeDefined();
  });

  it('refuses unpaired calls, wrong codes, and files that don’t match their hash', async () => {
    const { hub, browser, client, fetchOver, ADDRESS } = setup();
    await expect(client('nope').hello(null)).rejects.toThrow(/isn’t paired/);
    hub.newCode();
    for (let i = 0; i < 4; i++) await expect(pairWithHub(browser, client(), ADDRESS, 'WRONG', 'X')).rejects.toThrow(/wrong/);
    // The fifth wrong guess withdraws the code.
    await expect(pairWithHub(browser, client(), ADDRESS, 'WRONG', 'X')).rejects.toThrow(/wrong/);
    expect(hub.codePending()).toBe(false);

    const { code } = hub.newCode();
    const { key, chosenFiles } = await pairWithHub(browser, client(), ADDRESS, code, 'X');
    expect(chosenFiles).toBeUndefined();
    const put = await fetchOver(`${ADDRESS}/api/sync/files/${'a'.repeat(64)}`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${key}` },
      body: 'not that',
    });
    expect(put.status).toBe(400);
    const get = await fetchOver(`${ADDRESS}/api/sync/files/${'a'.repeat(64)}`, { headers: { Authorization: `Bearer ${key}` } });
    expect(get.status).toBe(404);
    const unauthorized = await fetchOver(`${ADDRESS}/api/sync/files/${'a'.repeat(64)}`);
    expect(unauthorized.status).toBe(401);

    await hub.unpair((await browser.getLibrary()).origin);
    await expect(client(key).hello(null)).rejects.toThrow(/isn’t paired/);
  });

  it('lets a code expire', async () => {
    const { hub, browser, client, ADDRESS, advance } = setup();
    const { code } = hub.newCode();
    advance(11 * 60_000);
    await expect(pairWithHub(browser, client(), ADDRESS, code, 'X')).rejects.toThrow(/expired/);
  });
});
