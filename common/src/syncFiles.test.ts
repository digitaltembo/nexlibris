import { describe, expect, it } from 'vitest';
import { StoredLibraryBackend } from './backend';
import { createItem, type Operation } from './operations';
import { MemoryStorage } from './storage';
import { fetchingMissingFiles, referencedFiles, transferFiles, type HubFiles } from './syncFiles';

const blob = (text: string) => new Blob([text]);

/** A hub's files as the transfer reaches them, copying between two backends' storage. */
function hubFiles(hub: StoredLibraryBackend, phone: StoredLibraryBackend, broken = new Set<string>()): HubFiles & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    missing: async (hashes) => {
      const lacking = [];
      for (const hash of hashes) if (!(await hub.hasFile(hash))) lacking.push(hash);
      return lacking;
    },
    download: async (hash) => {
      calls.push(`down ${hash.slice(0, 4)}`);
      if (broken.has(hash)) throw new Error('connection reset');
      await phone.putFile((await hub.getFile(hash))!);
    },
    upload: async (hash) => {
      calls.push(`up ${hash.slice(0, 4)}`);
      await hub.putFile((await phone.getFile(hash))!);
    },
  };
}

/** Stores each text in `backend` and returns refs to them. */
async function store(backend: StoredLibraryBackend, ...texts: string[]) {
  return Promise.all(texts.map(async (text) => ({ ...(await backend.putFile(blob(text))), format: 'epub', name: `${text}.epub` })));
}

describe('transferFiles', () => {
  it('sends the hub what it lacks, then fetches covers and the kept books’ files', async () => {
    const hub = new StoredLibraryBackend(new MemoryStorage());
    const phone = new StoredLibraryBackend(new MemoryStorage());
    const [mine] = await store(phone, 'phone book');
    const [cover, kept, other] = await store(hub, 'cover', 'kept book', 'other book');
    const items = [
      createItem({ title: 'Mine', files: [mine!] }),
      createItem({ title: 'Kept', tags: ['reading'], files: [kept!], cover: { hash: cover!.hash, mediaType: 'image/png' } }),
      createItem({ title: 'Other', files: [other!] }),
    ];
    const ops: Operation[] = items.map((item) => ({ type: 'addItem', item }));
    // Both libraries agree after the sync; only the files differ.
    await phone.apply(ops);
    await hub.apply(ops);

    const files = hubFiles(hub, phone);
    const progress: string[] = [];
    const result = await transferFiles(phone, files, {
      keep: (item) => item.tags.includes('reading'),
      onProgress: (p) => progress.push(`${p.direction} ${p.done}/${p.total}`),
    });
    expect(result).toEqual({ uploaded: 1, downloaded: 2, failed: [], notKept: 1, notSent: 0, unavailable: 0 });
    expect(await hub.hasFile(mine!.hash)).toBe(true);
    expect(await phone.hasFile(cover!.hash)).toBe(true);
    expect(await phone.hasFile(kept!.hash)).toBe(true);
    expect(await phone.hasFile(other!.hash)).toBe(false);
    expect(progress).toEqual(['upload 0/1', 'upload 1/1', 'download 0/2', 'download 1/2', 'download 2/2']);

    // Nothing left to do, but the one book the rule leaves on the hub.
    files.calls.length = 0;
    expect(await transferFiles(phone, files, { keep: (item) => item.tags.includes('reading') })).toEqual({
      uploaded: 0,
      downloaded: 0,
      failed: [],
      notKept: 1,
      notSent: 0,
      unavailable: 0,
    });
    expect(files.calls).toEqual([]);
  });

  it('sends the hub only covers and the books its `send` rule picks', async () => {
    const hub = new StoredLibraryBackend(new MemoryStorage());
    const phone = new StoredLibraryBackend(new MemoryStorage());
    const [cover, wanted, held] = await store(phone, 'cover', 'wanted book', 'held book');
    const ops: Operation[] = [
      createItem({ title: 'Wanted', tags: ['desk'], files: [wanted!], cover: { hash: cover!.hash, mediaType: 'image/png' } }),
      createItem({ title: 'Held', files: [held!] }),
    ].map((item) => ({ type: 'addItem', item }));
    await phone.apply(ops);
    await hub.apply(ops);

    const result = await transferFiles(phone, hubFiles(hub, phone), { send: (item) => item.tags.includes('desk') });
    expect(result).toMatchObject({ uploaded: 2, notSent: 1 });
    expect(await hub.hasFile(cover!.hash)).toBe(true);
    expect(await hub.hasFile(wanted!.hash)).toBe(true);
    expect(await hub.hasFile(held!.hash)).toBe(false);
  });

  it('leaves files the hub doesn’t have yet for a later sync', async () => {
    const hub = new StoredLibraryBackend(new MemoryStorage());
    const phone = new StoredLibraryBackend(new MemoryStorage());
    const [there] = await store(hub, 'there');
    // On a third instance, which hasn't synced its files yet.
    const elsewhere = { hash: 'e'.repeat(64), size: 9, format: 'epub' };
    await phone.apply([{ type: 'addItem', item: createItem({ title: 'Two', files: [there!, elsewhere] }) }]);
    const files = hubFiles(hub, phone);
    expect(await transferFiles(phone, files)).toEqual({ uploaded: 0, downloaded: 1, failed: [], notKept: 0, notSent: 0, unavailable: 1 });
    expect(files.calls).toEqual([`down ${there!.hash.slice(0, 4)}`]);
  });

  it('carries on past a file that fails, and reports it', async () => {
    const hub = new StoredLibraryBackend(new MemoryStorage());
    const phone = new StoredLibraryBackend(new MemoryStorage());
    const [a, b] = await store(hub, 'a', 'b');
    await phone.apply([{ type: 'addItem', item: createItem({ title: 'Two files', files: [a!, b!] }) }]);
    const result = await transferFiles(phone, hubFiles(hub, phone, new Set([a!.hash])));
    expect(result.downloaded).toBe(1);
    expect(result.failed).toEqual([{ hash: a!.hash, direction: 'download', message: 'connection reset' }]);
    expect(await phone.hasFile(b!.hash)).toBe(true);
  });

  it('lists every file a library refers to, with the items using each', async () => {
    const shared = { hash: 'f'.repeat(64), size: 1, format: 'epub' };
    const one = createItem({ title: 'One', files: [shared], cover: { hash: 'c'.repeat(64), mediaType: 'image/png' } });
    const two = createItem({ title: 'Two', files: [shared] });
    const phone = new StoredLibraryBackend(new MemoryStorage());
    const library = await phone.apply([
      { type: 'addItem', item: one },
      { type: 'addItem', item: two },
    ]);
    const { covers, books } = referencedFiles(library);
    expect([...covers]).toEqual(['c'.repeat(64)]);
    expect(books.get(shared.hash)!.map((item) => item.title)).toEqual(['One', 'Two']);
  });
});

describe('fetchingMissingFiles', () => {
  it('fetches a file it lacks once, however many read it', async () => {
    const hub = new StoredLibraryBackend(new MemoryStorage());
    const phone = new StoredLibraryBackend(new MemoryStorage());
    const [book] = await store(hub, 'book');
    let fetches = 0;
    const backend = fetchingMissingFiles(phone, async (hash) => {
      fetches++;
      if (!(await hub.hasFile(hash))) return false;
      await phone.putFile((await hub.getFile(hash))!);
      return true;
    });
    const [a, b] = await Promise.all([backend.getFile(book!.hash), backend.getFile(book!.hash)]);
    expect(await a!.text()).toBe('book');
    expect(await b!.text()).toBe('book');
    expect(await backend.getFile(book!.hash)).toBeDefined();
    expect(fetches).toBe(1);
    expect(await backend.getFile('0'.repeat(64))).toBeUndefined();
    expect(fetches).toBe(2);
  });

  it('passes on why a fetch failed', async () => {
    const backend = fetchingMissingFiles(new StoredLibraryBackend(new MemoryStorage()), () => Promise.reject(new Error('Couldn’t reach the hub.')));
    await expect(backend.getFile('0'.repeat(64))).rejects.toThrow('Couldn’t reach the hub.');
  });
});
