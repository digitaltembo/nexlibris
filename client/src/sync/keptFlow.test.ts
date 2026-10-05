import {
  createItem,
  createMessageClient,
  createSyncHub,
  decodeMessage,
  encodeMessage,
  httpHubFiles,
  httpSend,
  MemoryStorage,
  messageFetch,
  pairWithHub,
  previewSync,
  runSync,
  StoredLibraryBackend,
  syncApiMeta,
  transferFiles,
  type FileProgress,
  type Library,
  type SyncMessageRequest,
} from '@nexlibris/common';
import { describe, expect, it } from 'vitest';
import { deleteItems } from '../library/freeFiles';
import { addInstances, instanceScope, keptBy, letGo, pairedConnections } from './instances';

const titles = (library: Library) => Object.values(library.items).map((item) => item.title).sort();

async function setup() {
  const desktop = new StoredLibraryBackend(new MemoryStorage(), 'Desktop');
  const storage = new MemoryStorage();
  const android = new StoredLibraryBackend(storage, 'Android');
  const hashes: Record<string, string> = {};
  for (const [title, tags] of [['Dune', ['travel']], ['Emma', []], ['Ulysses', []]] as const) {
    const { hash, size } = await desktop.putFile(new Blob([title]));
    hashes[title] = hash;
    await desktop.apply([{ type: 'addItem', item: createItem({ title, tags: [...tags], files: [{ hash, size, format: 'epub' }] }) }]);
  }
  const hub = createSyncHub(desktop, { name: () => 'Desk', scope: instanceScope });
  /** Every message the hub answered, as the phone received it. */
  const received: string[] = [];
  const fetchOver = messageFetch(async (message) => {
    const { header, body } = decodeMessage<SyncMessageRequest>(message);
    const response = await hub.handle({ ...header, body });
    received.push(new TextDecoder().decode(response.body));
    return encodeMessage({ status: response.status }, response.body);
  });
  const client = (key?: string) => createMessageClient(syncApiMeta, httpSend('bt://hub', key, fetchOver)).sync;
  const pair = async (keepFiles?: string) => {
    const pairing = await pairWithHub(android, client(), 'bt://hub', hub.newCode(keepFiles ? { keepFiles } : null).code, 'Android');
    await android.apply(pairedConnections(await android.getLibrary(), pairing, 'Android'));
    return pairing;
  };
  /** As SyncInstance does. */
  const sync = async (pairing: Awaited<ReturnType<typeof pair>>) => {
    const preview = await previewSync(android, client(pairing.key), pairing);
    const result = await runSync(android, client(pairing.key), pairing, preview);
    const library = await android.getLibrary();
    const missing = addInstances(library, [{ origin: library.origin, name: 'Android' }, { origin: pairing.hub.origin, name: 'Desk' }]);
    if (missing.length) await android.apply(missing);
    const after = await android.getLibrary();
    const progress: FileProgress[] = [];
    const hubFiles = httpHubFiles('bt://hub', pairing.key, android, fetchOver);
    const files = await transferFiles(android, hubFiles, {
      keep: keptBy(after, after.origin),
      send: keptBy(after, pairing.hub.origin),
      onProgress: (p) => progress.push(p),
    });
    const left = await letGo(android, hubFiles, result);
    return { preview, result, pairing: left?.pairing ?? result.pairing, files, progress, left: left?.left, query: after.devices![after.origin]!.query };
  };
  return { desktop, android, storage, hashes, received, pair, sync };
}

/** A phone paired with a hub that chooses which books it keeps, synced as `SyncInstance` does. */
describe('choosing books for a paired instance', () => {
  it('sees and fetches only the chosen books when they were chosen with the code', async () => {
    const { android, received, pair, sync } = await setup();
    const first = await sync(await pair('tag:travel'));
    expect(first.query).toBe('tag:travel');
    expect(titles(await android.getLibrary())).toEqual(['Dune']);
    expect(first.files).toMatchObject({ downloaded: 1, notKept: 0 });
    expect(first.progress.at(-1)).toMatchObject({ direction: 'download', total: 1, books: 1 });
    // Nothing the hub sent names the other books, so they're in neither the library nor its log.
    expect(received.join('\n')).not.toMatch(/Emma|Ulysses/);
    expect(JSON.stringify(await android.getChanges(0))).not.toMatch(/Emma|Ulysses/);
  });

  it('does so when they were chosen on the hub after pairing, before the first sync', async () => {
    const { desktop, android, pair, sync } = await setup();
    const pairing = await pair();
    const origin = (await android.getLibrary()).origin;
    await desktop.apply(addInstances(await desktop.getLibrary(), [{ origin, name: 'Android' }], 'tag:travel'));
    const first = await sync(pairing);
    expect(first.query).toBe('tag:travel');
    expect(titles(await android.getLibrary())).toEqual(['Dune']);
    expect(first.files.downloaded).toBe(1);
  });

  it('lets go of books, and their files, once a choice made on the hub leaves them out', async () => {
    const { desktop, android, hashes, pair, sync } = await setup();
    const pairing = await pair();
    const first = await sync(pairing);
    expect(titles(await android.getLibrary())).toEqual(['Dune', 'Emma', 'Ulysses']);
    expect(first.files.downloaded).toBe(3);

    const origin = (await android.getLibrary()).origin;
    await desktop.apply([{ type: 'updateDevice', id: origin, patch: { query: 'tag:travel' } }]);
    const second = await sync(first.pairing);
    expect(second.query).toBe('tag:travel');
    expect(titles(await android.getLibrary())).toEqual(['Dune']);
    expect(second.left).toEqual({ books: 2, files: 2, bytes: 'Emma'.length + 'Ulysses'.length });
    expect(await android.hasFile(hashes.Emma!)).toBe(false);
    expect(await android.hasFile(hashes.Dune!)).toBe(true);
    // Still all on the hub, and the next sync is quiet.
    expect(titles(await desktop.getLibrary())).toEqual(['Dune', 'Emma', 'Ulysses']);
    const third = await sync(second.pairing);
    expect(third.preview.plan).toMatchObject({ ours: [], theirs: [] });
    expect(third.result.repaired).toEqual([]);

    // Choosing every book again brings them back.
    await desktop.apply([{ type: 'updateDevice', id: origin, patch: { query: 'has:file' } }]);
    await sync(third.pairing);
    expect(titles(await android.getLibrary())).toEqual(['Dune', 'Emma', 'Ulysses']);
  });

  it('keeps a book deleted on the phone on the hub, and off the phone from then on', async () => {
    const { desktop, android, hashes, pair, sync } = await setup();
    const first = await sync(await pair());
    const library = await android.getLibrary();
    const emma = Object.values(library.items).find((item) => item.title === 'Emma')!;
    expect(await deleteItems(android, async (ops) => void (await android.apply(ops)), [emma])).toEqual({ files: 1, bytes: 4 });
    expect(await android.hasFile(hashes.Emma!)).toBe(false);

    const second = await sync(first.pairing);
    expect(second.preview.keptOff).toEqual([emma.id]);
    expect(second.result.repaired).toEqual([]);
    expect(titles(await desktop.getLibrary())).toEqual(['Dune', 'Emma', 'Ulysses']);
    expect((await desktop.getLibrary()).devices![library.origin]!.excluded).toEqual([emma.id]);
    expect(titles(await android.getLibrary())).toEqual(['Dune', 'Ulysses']);

    // It doesn't come back, and the phone's edits still reach the hub.
    const dune = Object.values((await android.getLibrary()).items).find((item) => item.title === 'Dune')!;
    await android.apply([{ type: 'addTags', id: dune.id, tags: ['reread'] }]);
    const third = await sync(second.pairing);
    expect(third.result.repaired).toEqual([]);
    expect(titles(await android.getLibrary())).toEqual(['Dune', 'Ulysses']);
    expect((await desktop.getLibrary()).items[dune.id]!.tags).toEqual(['travel', 'reread']);
  });

  it('sends the hub a book added on the phone, even one its choice leaves out, then lets go of it', async () => {
    const { desktop, android, pair, sync } = await setup();
    const first = await sync(await pair('tag:travel'));
    const { hash, size } = await android.putFile(new Blob(['Middlemarch']));
    const book = createItem({ title: 'Middlemarch', files: [{ hash, size, format: 'epub' }] });
    await android.apply([{ type: 'addItem', item: book }]);
    const second = await sync(first.pairing);
    expect(second.files.uploaded).toBe(1);
    expect(titles(await desktop.getLibrary())).toEqual(['Dune', 'Emma', 'Middlemarch', 'Ulysses']);
    expect(await desktop.hasFile(hash)).toBe(true);
    expect(second.left?.books).toBe(1);
    expect(titles(await android.getLibrary())).toEqual(['Dune']);
  });
});
