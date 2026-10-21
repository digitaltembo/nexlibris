import { createDevice, createItem, MemoryStorage, StoredLibraryBackend, type FileRef } from '@nexlibris/common';
import { describe, expect, it, vi } from 'vitest';
import { connectionContents, importFromConnection, linkOperations, matchItem, removeOperations } from './contents';
import { listDevice, planSync } from './plan';
import { runSync } from './run';
import type { DeviceTarget, FilesType, RemoteFile } from './types';

// Under Node the Kindle parser fetches resources; nothing here imports Kindle files.
vi.mock('@nexlibris/tools/formats/kindle', () => ({}));

/** A device as a map of path to contents, that can send files back. */
class FakeDevice implements DeviceTarget {
  files = new Map<string, string>();
  async connect() {
    return { description: 'Fake' };
  }
  async list(folder: string): Promise<RemoteFile[]> {
    return [...this.files]
      .filter(([path]) => path.slice(0, path.lastIndexOf('/')) === folder)
      .map(([path, text]) => ({ path, size: text.length }));
  }
  async ensureFolder() {}
  async upload(path: string, data: Blob) {
    this.files.set(path, await data.text());
  }
  async remove(path: string) {
    this.files.delete(path);
  }
  async download(path: string) {
    const text = this.files.get(path);
    if (text === undefined) throw new Error(`no ${path}`);
    return new Blob([text]);
  }
  /** Everything on it, as an inventory lists it. */
  books() {
    return [...this.files].map(([path, text]) => ({ path, size: text.length }));
  }
}

const type: FilesType = {
  access: 'files',
  id: 'test.reader',
  label: 'Reader',
  read: true,
  write: { single: true },
  formats: () => ['epub', 'txt'],
  settings: [],
  folder: () => '/Books',
  target: () => {
    throw new Error('unused');
  },
};

async function setup() {
  const backend = new StoredLibraryBackend(new MemoryStorage());
  const add = async (title: string, author: string, files: Record<string, string>) => {
    const refs: FileRef[] = [];
    for (const [format, text] of Object.entries(files)) {
      const { hash, size } = await backend.putFile(new Blob([text]));
      refs.push({ hash, size, format });
    }
    const item = createItem({ title, creators: [{ name: author, role: 'aut' }], files: refs });
    await backend.apply([{ type: 'addItem', item }]);
    return item;
  };
  const dune = await add('Dune', 'Frank Herbert', { epub: 'dune epub' });
  const emma = await add('Emma', 'Jane Austen', { epub: 'emma epub' });
  const solaris = await add('Solaris', 'Stanisław Lem', { epub: 'solaris epub' });
  const scan = await add('Old Scan', 'Someone', { pdf: 'a pdf' });
  const device = createDevice({ name: 'Reader', type: type.id });
  await backend.apply([{ type: 'addDevice', device }, { type: 'addDeviceItems', id: device.id, itemIds: [dune.id] }]);
  const target = new FakeDevice();
  const sync = async () => {
    const library = await backend.getLibrary();
    const current = library.devices![device.id]!;
    const plan = planSync(library, current, type, await listDevice(current, type, target));
    await backend.apply((await runSync(library, current, plan, target, backend)).operations);
    return plan;
  };
  const contents = async () => {
    const library = await backend.getLibrary();
    return connectionContents(library, library.devices![device.id]!, type, target.books());
  };
  return { backend, target, deviceId: device.id, dune, emma, solaris, scan, sync, contents };
}

describe('connection contents', () => {
  it('sorts what’s on a device: sent by a sync, in the library, or not, and what’s still to come', async () => {
    const { backend, target, deviceId, dune, emma, scan, solaris, sync, contents } = await setup();
    await sync();
    target.files.set('/Books/Emma - Jane Austen.epub', 'a copy put there by hand');
    target.files.set('/Other/Old Scan - Someone.pdf', 'scan');
    target.files.set('/Books/Persuasion.epub', 'persuasion');
    await backend.apply([{ type: 'addDeviceItems', id: deviceId, itemIds: [solaris.id] }]);

    const { entries, pending } = await contents();
    expect(entries.map((e) => [e.book.path, e.kind, 'item' in e ? e.item?.title : undefined])).toEqual([
      ['/Books/Dune - Frank Herbert.epub', 'placed', 'Dune'],
      ['/Books/Emma - Jane Austen.epub', 'match', 'Emma'],
      ['/Other/Old Scan - Someone.pdf', 'match', 'Old Scan'],
      ['/Books/Persuasion.epub', 'unknown', undefined],
    ]);
    expect(entries[0]).toMatchObject({ status: 'current' });
    // Emma has an EPUB the reader takes; the scan only a PDF, which it doesn't.
    expect(entries.filter((e) => e.kind === 'match').map((e) => e.linkable)).toEqual([true, false]);
    expect(pending.map((item) => item.title)).toEqual(['Solaris']);
    expect([dune, emma, scan].every(Boolean)).toBe(true);

    // Changed on the device, or out of the catalog (and left there).
    target.files.set('/Books/Dune - Frank Herbert.epub', 'edited on the reader');
    expect((await contents()).entries[0]).toMatchObject({ kind: 'placed', status: 'changed' });
    target.files.set('/Books/Dune - Frank Herbert.epub', 'dune epub');
    await backend.apply([{ type: 'removeDeviceItems', id: deviceId, itemIds: [dune.id] }]);
    expect((await contents()).entries[0]).toMatchObject({ kind: 'placed', status: 'left' });
  });

  it('links a book put there by hand, so syncs keep it rather than treating it as someone else’s', async () => {
    const { backend, target, deviceId, emma, sync, contents } = await setup();
    await sync();
    // Named its own way, so only the reader's metadata could match it; linked as the Link button does.
    const path = '/Books/Emma, by hand.epub';
    target.files.set(path, 'emma epub');
    expect((await contents()).entries.find((e) => e.book.path === path)).toMatchObject({ kind: 'unknown' });
    const library = await backend.getLibrary();
    await backend.apply(linkOperations(library, library.devices![deviceId]!, type, { path, size: 9 }, emma));

    expect((await contents()).entries.find((e) => e.book.path === path)).toMatchObject({ kind: 'placed', status: 'current' });
    const plan = await sync();
    expect(plan.uploads).toEqual([]);
    expect(plan.removals).toEqual([]);
    expect(target.files.get(path)).toBe('emma epub');

    // Once the library's copy changes, the next sync replaces it, under the book's own name.
    const { hash, size } = await backend.putFile(new Blob(['emma, second edition']));
    await backend.apply([
      { type: 'detachFile', id: emma.id, hash: emma.files[0]!.hash },
      { type: 'attachFile', id: emma.id, file: { hash, size, format: 'epub' } },
    ]);
    expect((await contents()).entries.find((e) => e.book.path === path)).toMatchObject({ status: 'update' });
    await sync();
    expect(target.files.has(path)).toBe(false);
    expect(target.files.get('/Books/Emma - Jane Austen.epub')).toBe('emma, second edition');
  });

  it('takes a removed book off the connection, so the next sync doesn’t send it back', async () => {
    const { backend, target, deviceId, dune, emma, sync, contents } = await setup();
    // Dune chosen by hand, Emma by the connection's search.
    await backend.apply([{ type: 'updateDevice', id: deviceId, patch: { query: 'title:Emma' } }]);
    await sync();
    const remove = async (path: string) => {
      const entry = (await contents()).entries.find((e) => e.book.path === path)!;
      await target.remove(path);
      const library = await backend.getLibrary();
      await backend.apply(removeOperations(library, library.devices![deviceId]!, entry));
    };
    await remove('/Books/Dune - Frank Herbert.epub');
    await remove('/Books/Emma - Jane Austen.epub');

    const device = (await backend.getLibrary()).devices![deviceId]!;
    expect(device.items).not.toContain(dune.id);
    expect(device.excluded).toEqual([emma.id]);
    expect(device.placed).toEqual({});
    const plan = await sync();
    expect(plan.uploads).toEqual([]);
    expect(target.books()).toEqual([]);
  });

  it('needs nothing in the library to delete a book it doesn’t have', async () => {
    const { backend, deviceId } = await setup();
    const library = await backend.getLibrary();
    expect(removeOperations(library, library.devices![deviceId]!, { kind: 'unknown', book: { path: '/Books/Persuasion.epub', size: 3 } })).toEqual([]);
  });

  it('won’t link a book the connection can’t send, which a sync would then remove', async () => {
    const { backend, deviceId, scan } = await setup();
    const library = await backend.getLibrary();
    expect(() => linkOperations(library, library.devices![deviceId]!, type, { path: '/x.pdf', size: 5 }, scan)).toThrow(
      /no file this connection takes/,
    );
  });

  it('imports a book the library hasn’t got, and keeps it on the device', async () => {
    const { backend, target, deviceId, sync, contents } = await setup();
    target.files.set('/Books/Persuasion - Jane Austen.txt', 'It was a quiet novel.');
    const book = (await contents()).entries.find((e) => e.kind === 'unknown')!.book;
    const library = await backend.getLibrary();
    const { item, linked } = await importFromConnection(backend, library.devices![deviceId]!, type, target, book);
    expect(linked).toBe(true);
    expect(item.files.map((f) => f.format)).toEqual(['txt']);
    expect((await contents()).entries.find((e) => e.book.path === book.path)).toMatchObject({ kind: 'placed', status: 'current' });
    const plan = await sync();
    expect(plan.removals).toEqual([]);
    expect(target.files.has(book.path)).toBe(true);

    // Importing it again finds the item that has it.
    const again = await importFromConnection(backend, (await backend.getLibrary()).devices![deviceId]!, type, target, book);
    expect(again.item.id).toBe(item.id);
  });

  it('matches on the device’s metadata, or on a file named as a sync names books', async () => {
    const { backend } = await setup();
    const library = await backend.getLibrary();
    expect(matchItem(library, { path: '/a.epub', size: 1, title: 'SOLARIS', author: 'stanisław lem' })?.title).toBe('Solaris');
    expect(matchItem(library, { path: '/Books/Dune - Frank Herbert.x4.epub', size: 1 })?.title).toBe('Dune');
    expect(matchItem(library, { path: '/Books/Dune.epub', size: 1, title: 'Dune', author: 'Someone Else' })).toBeUndefined();
  });
});
