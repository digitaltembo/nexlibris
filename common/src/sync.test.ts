import { describe, expect, it } from 'vitest';
import { RevisionMismatchError, StoredLibraryBackend, type LibraryBackend } from './backend';
import { createDevice, createItem, type Operation } from './operations';
import type { ScopeRule } from './scope';
import { stateDigest } from './repair';
import { createMessageClient, createMessageHandler, type MessageImpl } from './rpc';
import { MemoryStorage } from './storage';
import { createSyncService, peerOffer, previewSync, readPairings, requestFromPeer, runSync, type Pairing, type SyncClient } from './sync';
import { syncApiMeta, type SyncApi } from './syncApi';

/** A hub (its backend, served through the real message handler with a JSON round trip) and a phone to sync with it. */
async function setup(options: { breakApply?: boolean; scope?: ScopeRule } = {}) {
  const hub = new StoredLibraryBackend(new MemoryStorage(), 'Desk');
  const phone = new StoredLibraryBackend(new MemoryStorage(), 'Phone');
  const service = createSyncService(hub, { name: () => 'Desktop', ...(options.scope && { scope: options.scope }) });
  const done: string[] = [];
  let applies = 0;
  const impl: MessageImpl<SyncApi> = {
    sync: {
      ...service,
      // A hub whose first apply drops the last operation it's sent: a merge bug, as far as the check after the merge can tell.
      apply: (request) => {
        const broken = options.breakApply && applies++ === 0;
        return service.apply(broken ? { ...request, ops: request.ops.slice(0, -1) } : request);
      },
      pair: async () => {
        throw new Error('not used here');
      },
      done: async ({ origin }) => (done.push(origin), null),
      missing: async () => [],
    },
  };
  const handle = createMessageHandler(syncApiMeta, impl);
  let id = 0;
  const client: SyncClient = createMessageClient(syncApiMeta, async (request) => {
    const response = await handle(JSON.parse(JSON.stringify({ ...request, id: ++id })));
    if (!response.ok) throw new Error(response.message);
    return JSON.parse(JSON.stringify(response.value));
  }).sync;
  const info = await client.hello(null);
  const pairing: Pairing = {
    hub: { origin: info.origin, name: info.name, libraryName: info.libraryName },
    address: 'http://hub',
    key: 'k',
    truth: 'theirs',
  };
  return { hub, phone, client, pairing, done };
}

const titles = async (backend: LibraryBackend) =>
  Object.values((await backend.getLibrary()).items)
    .map((item) => item.title)
    .sort();
const hashOf = async (backend: LibraryBackend) => stateDigest(await backend.getLibrary()).hash;
const add = (title: string): Operation => ({ type: 'addItem', item: createItem({ title }) });

/** Previews and runs a sync, as the sync dialog does. */
async function sync(s: Awaited<ReturnType<typeof setup>>, options: Parameters<typeof previewSync>[3] = {}) {
  const pairing = (await readPairings(s.phone))[0] ?? s.pairing;
  const preview = await previewSync(s.phone, s.client, pairing, options);
  return { preview, result: await runSync(s.phone, s.client, pairing, preview) };
}

describe('sync', () => {
  it('combines two libraries on a first sync, then has nothing to do', async () => {
    const s = await setup();
    await s.hub.apply([add('Dune'), add('Emma')]);
    await s.phone.apply([add('Piranesi')]);
    const { preview, result } = await sync(s);
    expect(preview.first).toBe('combine');
    expect(result).toMatchObject({ received: 2, sent: 1, repaired: [] });
    expect(await titles(s.phone)).toEqual(['Dune', 'Emma', 'Piranesi']);
    expect(await titles(s.hub)).toEqual(['Dune', 'Emma', 'Piranesi']);
    expect(await hashOf(s.phone)).toBe(await hashOf(s.hub));
    // The pairing remembers where the two agreed, and the hub heard about the sync.
    const [pairing] = await readPairings(s.phone);
    expect(pairing!.base).toEqual({ ours: (await s.phone.getLibrary()).revision, theirs: (await s.hub.getLibrary()).revision });
    expect(s.done).toEqual([(await s.phone.getLibrary()).origin]);

    const again = await previewSync(s.phone, s.client, pairing!);
    expect(again.first).toBeUndefined();
    expect(again.plan).toEqual({ ours: [], theirs: [], conflicts: [] });
  });

  it('replaces this library with the hub’s when asked to', async () => {
    const s = await setup();
    await s.hub.apply([add('Dune')]);
    await s.phone.apply([add('Piranesi')]);
    const { result } = await sync(s, { first: 'replace' });
    expect(result.sent).toBe(0);
    expect(await titles(s.phone)).toEqual(['Dune']);
    expect(await titles(s.hub)).toEqual(['Dune']);
  });

  it('merges later edits from both sides, with the source of truth deciding disagreements', async () => {
    const s = await setup();
    await s.hub.apply([add('Dune')]);
    await sync(s);
    const id = Object.keys((await s.hub.getLibrary()).items)[0]!;
    await s.hub.apply([{ type: 'updateItem', id, patch: { title: 'Dune (desk)' } }, add('Emma')]);
    await s.phone.apply([{ type: 'updateItem', id, patch: { title: 'Dune (phone)' } }, add('Piranesi')]);

    const { preview, result } = await sync(s);
    expect(preview.plan.conflicts).toEqual([
      { target: ['item', id, 'title'], ours: 'Dune (phone)', theirs: 'Dune (desk)', winner: 'theirs' },
    ]);
    expect(result.conflicts).toHaveLength(1);
    expect(await titles(s.phone)).toEqual(['Dune (desk)', 'Emma', 'Piranesi']);

    // This time with the phone as the source of truth, for this sync only.
    await s.hub.apply([{ type: 'updateItem', id, patch: { title: 'Dune (desk 2)' } }]);
    await s.phone.apply([{ type: 'updateItem', id, patch: { title: 'Dune (phone 2)' } }]);
    await sync(s, { truth: 'ours' });
    expect(await titles(s.hub)).toEqual(['Dune (phone 2)', 'Emma', 'Piranesi']);
    expect(await hashOf(s.phone)).toBe(await hashOf(s.hub));
    expect((await readPairings(s.phone))[0]!.truth).toBe('theirs');
  });

  it('applies nothing if the hub changed after the preview, and works when run again', async () => {
    const s = await setup();
    await s.phone.apply([add('Piranesi')]);
    const preview = await previewSync(s.phone, s.client, s.pairing);
    await s.hub.apply([add('Dune')]);
    await expect(runSync(s.phone, s.client, s.pairing, preview)).rejects.toThrow(/changed while/);
    expect(await titles(s.hub)).toEqual(['Dune']);
    expect(await titles(s.phone)).toEqual(['Piranesi']);
    await sync(s);
    expect(await titles(s.phone)).toEqual(['Dune', 'Piranesi']);
  });

  it('finishes after being interrupted between the two sides', async () => {
    const s = await setup();
    await s.hub.apply([add('Dune')]);
    await s.phone.apply([add('Piranesi')]);
    const preview = await previewSync(s.phone, s.client, s.pairing);
    // An edit on the phone mid-sync: the hub's side is applied, the phone's isn't.
    const phoneApply = s.phone.apply.bind(s.phone);
    let interrupted = false;
    s.phone.apply = async (ops, expect) => {
      if (!interrupted && expect !== undefined) {
        interrupted = true;
        await phoneApply([add('Emma')]);
      }
      return phoneApply(ops, expect);
    };
    await expect(runSync(s.phone, s.client, s.pairing, preview)).rejects.toThrow(RevisionMismatchError);
    expect(await titles(s.hub)).toEqual(['Dune', 'Piranesi']);
    expect(await readPairings(s.phone)).toEqual([]);

    await sync(s);
    expect(await titles(s.phone)).toEqual(['Dune', 'Emma', 'Piranesi']);
    expect(await titles(s.hub)).toEqual(['Dune', 'Emma', 'Piranesi']);
  });

  it('repairs from the source of truth when the two still differ after the merge', async () => {
    const s = await setup({ breakApply: true });
    await s.phone.apply([add('Piranesi'), add('Left Hand')]);
    const { result } = await sync(s, { truth: 'ours' });
    expect(result.repaired).toHaveLength(1);
    expect(await titles(s.hub)).toEqual(['Left Hand', 'Piranesi']);
    expect(await hashOf(s.phone)).toBe(await hashOf(s.hub));
  });

  it('moves only what each side exposes, as Sync from and Sync to choose, and offers the rest to ask for', async () => {
    // The hub shows the phone its books tagged "phone"; the phone shows the hub everything but its diary.
    const s = await setup({ scope: () => (item) => item.tags.includes('phone') });
    const expose: ScopeRule = () => (item) => item.title !== 'Diary';
    const tagged = (title: string, tags: string[]): Operation => ({ type: 'addItem', item: createItem({ title, tags }) });
    await s.hub.apply([tagged('Dune', ['phone']), tagged('Emma', [])]);
    await s.phone.apply([add('Piranesi'), add('Notes'), add('Diary')]);

    // Sync from: the hub's exposed books come here; nothing goes there, the phone's exposed books are offered.
    const from = await sync(s, { push: 'none', expose });
    expect(from.preview).toMatchObject({ pushed: [] });
    expect(await titles(s.phone)).toEqual(['Diary', 'Dune', 'Notes', 'Piranesi']);
    expect(await titles(s.hub)).toEqual(['Dune', 'Emma']);
    const origin = (await s.phone.getLibrary()).origin;
    const offer = await peerOffer(s.hub, origin);
    expect(offer.items.map((item) => item.title).sort()).toEqual(['Notes', 'Piranesi']);

    // Asked for there, Notes comes with the next sync, even one that sends nothing else.
    await requestFromPeer(s.hub, origin, [offer.items.find((item) => item.title === 'Notes')!.id]);
    await sync(s, { push: 'none', expose });
    expect(await titles(s.hub)).toEqual(['Dune', 'Emma', 'Notes']);
    expect((await peerOffer(s.hub, origin)).requested).toEqual([]);

    // Sync to: the rest of what the phone exposes goes; its diary never does.
    const to = await sync(s, { pull: 'none', expose });
    expect(to.preview.pushed).toHaveLength(1);
    expect(await titles(s.hub)).toEqual(['Dune', 'Emma', 'Notes', 'Piranesi']);
  });

  it('never carries deletions across, and keeps deleted books off the side that deleted them', async () => {
    const keptOff: ScopeRule = (library, peer) => {
      const excluded = new Set(library.devices?.[peer]?.excluded);
      return (item) => !excluded.has(item.id);
    };
    const s = await setup({ scope: keptOff });
    const phoneOrigin = (await s.phone.getLibrary()).origin;
    const hubOrigin = (await s.hub.getLibrary()).origin;
    // Each side has a connection for the other, as instances do.
    const connections: Operation[] = [
      { type: 'addDevice', device: { ...createDevice({ name: 'Phone', type: 'nexlibris.instance' }), id: phoneOrigin } },
      { type: 'addDevice', device: { ...createDevice({ name: 'Desk', type: 'nexlibris.instance' }), id: hubOrigin } },
    ];
    await s.hub.apply([...connections, add('Dune'), add('Emma')]);
    await sync(s);
    const ids = Object.fromEntries(Object.values((await s.hub.getLibrary()).items).map((item) => [item.title, item.id]));
    await s.phone.apply([{ type: 'removeItem', id: ids.Dune! }]);
    await s.hub.apply([{ type: 'removeItem', id: ids.Emma! }]);

    const { preview } = await sync(s, { expose: keptOff });
    expect(preview).toMatchObject({ keptOff: [ids.Dune], keptHere: [ids.Emma] });
    expect(await titles(s.phone)).toEqual(['Emma']);
    expect(await titles(s.hub)).toEqual(['Dune']);
    // Later syncs don't bring them back either way.
    await sync(s, { expose: keptOff });
    expect(await titles(s.phone)).toEqual(['Emma']);
    expect(await titles(s.hub)).toEqual(['Dune']);
  });

  it('refuses a hub that is a different instance from the one paired with', async () => {
    const s = await setup();
    await expect(previewSync(s.phone, s.client, { ...s.pairing, hub: { ...s.pairing.hub, origin: 'someone-else' } })).rejects.toThrow(
      /different nexlibris instance/,
    );
  });
});
