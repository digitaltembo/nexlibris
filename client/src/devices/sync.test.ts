import {
  applyOperations,
  createDevice,
  createItem,
  createLibrary,
  MemoryStorage,
  StoredLibraryBackend,
  type Device,
  type FileRef,
  type Item,
  type Library,
} from '@nexlibris/common';
import { describe, expect, it } from 'vitest';
import { listDevice, planSync } from './plan';
import { runSync } from './run';
import type { Converter } from '../formats/convert/converters';
import type { DeviceTarget, DeviceType, RemoteFile } from './types';

/** A device as a map of path to contents. */
class FakeDevice implements DeviceTarget {
  files = new Map<string, string>();
  folders = new Set(['/']);
  failOn?: string;
  async connect() {
    return { description: 'Fake' };
  }
  async list(folder: string): Promise<RemoteFile[]> {
    return [...this.files]
      .filter(([path]) => path.slice(0, path.lastIndexOf('/')) === folder)
      .map(([path, text]) => ({ path, size: text.length }));
  }
  async ensureFolder(folder: string) {
    this.folders.add(folder);
  }
  async upload(path: string, data: Blob) {
    if (path === this.failOn) throw new Error('disk full');
    if (!this.folders.has(path.slice(0, path.lastIndexOf('/')))) throw new Error(`no folder for ${path}`);
    this.files.set(path, await data.text());
  }
  async remove(path: string) {
    this.files.delete(path);
  }
}

/** A device that also lists OPDS catalogs. */
class CatalogDevice extends FakeDevice {
  catalogs = [{ name: 'Gutenberg', url: 'https://gutenberg.org/opds' }];
  async listCatalogs() {
    return [...this.catalogs];
  }
  async addCatalog(catalog: { name: string; url: string }) {
    this.catalogs.push(catalog);
  }
}

const type: DeviceType = {
  id: 'test.reader',
  label: 'Reader',
  formats: ['x4.epub', 'epub'],
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
  const dune = await add('Dune', 'Frank Herbert', { epub: 'dune epub', 'x4.epub': 'dune x4' });
  const emma = await add('Emma: A Novel', 'Jane Austen', { epub: 'emma epub' });
  const notes = await add('Notes', 'Me', { txt: 'notes' });
  const device = createDevice({ name: 'X4', type: type.id });
  await backend.apply([{ type: 'addDevice', device }, { type: 'addDeviceItems', id: device.id, itemIds: [dune.id, emma.id, notes.id] }]);
  return { backend, dune, emma, notes, deviceId: device.id };
}

/** Like embedMetadata: writes the title and description into the file sent. */
const withMetadata: DeviceType = {
  ...type,
  prepare: {
    key: (item) => `${item.title}|${String(item.metadata.description)}`,
    run: async (item, _file, data) => new Blob([`${await data.text()} titled ${item.title}`]),
  },
};

async function sync(backend: StoredLibraryBackend, deviceId: string, target: FakeDevice, deviceType = type) {
  const library = await backend.getLibrary();
  const device = library.devices![deviceId]!;
  const plan = planSync(library, device, deviceType, await listDevice(device, deviceType, target));
  const result = await runSync(deviceId, plan, target, backend, deviceType.prepare);
  await backend.apply(result.operations);
  return { plan, result, device: (await backend.getLibrary()).devices![deviceId]! };
}

describe('device sync', () => {
  it('sends the best format of each chosen item, named for the book, and then has nothing to do', async () => {
    const { backend, deviceId, notes } = await setup();
    const target = new FakeDevice();
    const first = await sync(backend, deviceId, target);

    expect(Object.fromEntries(target.files)).toEqual({
      '/Books/Dune - Frank Herbert.epub': 'dune x4',
      '/Books/Emma A Novel - Jane Austen.epub': 'emma epub',
    });
    expect(first.plan.unsendable).toEqual([notes.id]);
    expect(first.result).toMatchObject({ sent: 2, removed: 0, errors: [] });
    expect(Object.keys(first.device.placed)).toHaveLength(2);

    const second = await sync(backend, deviceId, target);
    expect(second.plan).toMatchObject({ uploads: [], removals: [], conflicts: [], unchanged: 2 });
  });

  it('removes what it sent once it is no longer chosen, and resends changed files', async () => {
    const { backend, deviceId, dune, emma } = await setup();
    const target = new FakeDevice();
    await sync(backend, deviceId, target);

    const { hash, size } = await backend.putFile(new Blob(['dune x4, reconverted']));
    await backend.apply([
      { type: 'removeDeviceItems', id: deviceId, itemIds: [emma.id] },
      { type: 'detachFile', id: dune.id, hash: dune.files.find((f) => f.format === 'x4.epub')!.hash },
      { type: 'attachFile', id: dune.id, file: { hash, size, format: 'x4.epub' } },
      { type: 'updateItem', id: dune.id, patch: { title: 'Dune (Renamed)' } },
    ]);
    const { plan, device } = await sync(backend, deviceId, target);
    expect(plan.uploads).toMatchObject([
      { path: '/Books/Dune (Renamed) - Frank Herbert.epub', replaces: true, supersedes: '/Books/Dune - Frank Herbert.epub' },
    ]);
    expect(Object.fromEntries(target.files)).toEqual({ '/Books/Dune (Renamed) - Frank Herbert.epub': 'dune x4, reconverted' });
    expect(Object.keys(device.placed)).toEqual(['/Books/Dune (Renamed) - Frank Herbert.epub']);
  });

  it('sends books again when their metadata changes, under a new name only if it changes', async () => {
    const { backend, deviceId, dune, emma } = await setup();
    const target = new FakeDevice();
    await sync(backend, deviceId, target, withMetadata);
    expect(target.files.get('/Books/Dune - Frank Herbert.epub')).toBe('dune x4 titled Dune');
    expect((await sync(backend, deviceId, target, withMetadata)).plan.unchanged).toBe(2);

    await backend.apply([
      { type: 'setMetadata', id: emma.id, key: 'description', value: 'Matchmaking.' },
      { type: 'updateItem', id: dune.id, patch: { title: 'Dune Messiah' } },
    ]);
    const { plan } = await sync(backend, deviceId, target, withMetadata);
    expect(plan.uploads.map((u) => [u.path, u.replaces])).toEqual([
      ['/Books/Emma A Novel - Jane Austen.epub', true],
      ['/Books/Dune Messiah - Frank Herbert.epub', true],
    ]);
    expect(Object.fromEntries(target.files)).toEqual({
      '/Books/Dune Messiah - Frank Herbert.epub': 'dune x4 titled Dune Messiah',
      '/Books/Emma A Novel - Jane Austen.epub': 'emma epub titled Emma: A Novel',
    });
    expect((await sync(backend, deviceId, target, withMetadata)).plan.unchanged).toBe(2);
  });

  it('makes the device’s format when a book lacks it, keeps it, and remakes it for a new converter version', async () => {
    const optimizer = (version: string): Converter => ({
      id: 'test-x4',
      from: ['epub'],
      to: 'x4.epub',
      version,
      run: async (data) => new Blob([`${await data.text()} optimized v${version}`]),
    });
    const { backend, deviceId, emma } = await setup();
    const target = new FakeDevice();
    const makes = { ...type, makes: () => optimizer('1') };

    const first = await sync(backend, deviceId, target, makes);
    expect(first.plan.uploads.map((u) => [u.item.title, u.convert?.id])).toEqual([
      ['Dune', undefined],
      ['Emma: A Novel', 'test-x4'],
    ]);
    expect(target.files.get('/Books/Emma A Novel - Jane Austen.epub')).toBe('emma epub optimized v1');
    let library = await backend.getLibrary();
    const made = library.items[emma.id]!.files.find((f) => f.format === 'x4.epub')!;
    expect(made.derivedFrom).toMatchObject({ converter: 'test-x4', converterVersion: '1' });
    expect(first.device.placed['/Books/Emma A Novel - Jane Austen.epub']!.hash).toBe(made.hash);

    expect((await sync(backend, deviceId, target, makes)).plan).toMatchObject({ uploads: [], unchanged: 2 });

    const second = await sync(backend, deviceId, target, { ...type, makes: () => optimizer('2') });
    expect(second.plan.uploads.map((u) => [u.path, u.replaces])).toEqual([['/Books/Emma A Novel - Jane Austen.epub', true]]);
    expect(target.files.get('/Books/Emma A Novel - Jane Austen.epub')).toBe('emma epub optimized v2');
    library = await backend.getLibrary();
    expect(library.items[emma.id]!.files.map((f) => [f.format, f.derivedFrom?.converterVersion])).toEqual([
      ['epub', undefined],
      ['x4.epub', '2'],
    ]);
  });

  it('keeps the old copy when the renamed one fails to send', async () => {
    const { backend, deviceId, dune } = await setup();
    const target = new FakeDevice();
    await sync(backend, deviceId, target, withMetadata);
    await backend.apply([{ type: 'updateItem', id: dune.id, patch: { title: 'Dune Messiah' } }]);
    target.failOn = '/Books/Dune Messiah - Frank Herbert.epub';
    const { result, device } = await sync(backend, deviceId, target, withMetadata);
    expect(result.errors).toHaveLength(1);
    expect(target.files.has('/Books/Dune - Frank Herbert.epub')).toBe(true);
    expect(device.placed['/Books/Dune - Frank Herbert.epub']).toBeDefined();
  });

  it('never touches files it did not send, and lets go of ones changed on the device', async () => {
    const { backend, deviceId, emma } = await setup();
    const target = new FakeDevice();
    target.files.set('/Books/Dune - Frank Herbert.epub', 'my own copy');
    target.files.set('/Books/Other.epub', 'someone else');
    const first = await sync(backend, deviceId, target);
    expect(first.plan.conflicts).toMatchObject([{ path: '/Books/Dune - Frank Herbert.epub' }]);
    expect(target.files.get('/Books/Dune - Frank Herbert.epub')).toBe('my own copy');

    // Edited on the device: no longer the sync's, so it's neither replaced nor removed.
    target.files.set('/Books/Emma A Novel - Jane Austen.epub', 'emma, annotated on the device');
    await backend.apply([{ type: 'removeDeviceItems', id: deviceId, itemIds: [emma.id] }]);
    const second = await sync(backend, deviceId, target);
    expect(second.plan.removals).toEqual([]);
    expect(second.device.placed).toEqual({});
    expect(target.files.get('/Books/Emma A Novel - Jane Austen.epub')).toBe('emma, annotated on the device');
    expect(target.files.get('/Books/Other.epub')).toBe('someone else');
  });

  it('records what succeeded when a step fails, and forgets files deleted on the device', async () => {
    const { backend, deviceId } = await setup();
    const target = new FakeDevice();
    target.failOn = '/Books/Emma A Novel - Jane Austen.epub';
    const first = await sync(backend, deviceId, target);
    expect(first.result.errors).toEqual([{ path: '/Books/Emma A Novel - Jane Austen.epub', message: 'disk full' }]);
    expect(Object.keys(first.device.placed)).toEqual(['/Books/Dune - Frank Herbert.epub']);

    target.failOn = undefined;
    target.files.delete('/Books/Dune - Frank Herbert.epub');
    const second = await sync(backend, deviceId, target);
    expect(second.plan.forget).toEqual(['/Books/Dune - Frank Herbert.epub']);
    expect(second.result.sent).toBe(2);
    expect(target.files.size).toBe(2);
  });

  it('numbers books whose names would clash', () => {
    const one = createItem({ title: 'Poems', creators: [{ name: 'Anon', role: 'aut' }], files: [{ hash: 'a', size: 1, format: 'epub' }] });
    const two = createItem({ title: 'Poems', creators: [{ name: 'Anon', role: 'aut' }], files: [{ hash: 'b', size: 1, format: 'epub' }] });
    const odd = createItem({ title: '..Why? / Because: "yes"..', files: [{ hash: 'c', size: 1, format: 'epub' }] });
    const device: Device = { ...createDevice({ name: 'X4', type: type.id }), items: [one.id, two.id, odd.id] };
    const library: Library = applyOperations(createLibrary('L'), [one, two, odd].map((item: Item) => ({ type: 'addItem' as const, item }))).library;
    expect(planSync(library, device, type, { files: [] }).uploads.map((u) => u.path)).toEqual([
      '/Books/Poems - Anon.epub',
      '/Books/Poems - Anon (2).epub',
      '/Books/Why Because yes.epub',
    ]);
  });

  it('adds the device’s catalog to the reader’s list once', async () => {
    const { backend, deviceId } = await setup();
    const withCatalog: DeviceType = { ...type, catalog: (d) => ({ name: d.name, url: 'https://books.example/index.xml' }) };
    const target = new CatalogDevice();
    const first = await sync(backend, deviceId, target, withCatalog);
    expect(first.plan.catalog).toEqual({ name: 'X4', url: 'https://books.example/index.xml' });
    expect(first.result.catalogAdded).toBe(true);
    expect(target.catalogs.map((c) => c.url)).toEqual(['https://gutenberg.org/opds', 'https://books.example/index.xml']);

    const second = await sync(backend, deviceId, target, withCatalog);
    expect(second.plan.catalog).toBeUndefined();
    expect(second.result.catalogAdded).toBe(false);

    // A device that can't list catalogs isn't asked to add one.
    expect((await sync(backend, deviceId, new FakeDevice(), withCatalog)).plan.catalog).toBeUndefined();
  });

  it('sends what the device’s search matches, as it changes', async () => {
    const backend = new StoredLibraryBackend(new MemoryStorage());
    const add = async (title: string, tags: string[]) => {
      const { hash, size } = await backend.putFile(new Blob([title]));
      const item = createItem({ title, tags, creators: [{ name: 'Ann Leckie', role: 'aut' }], files: [{ hash, size, format: 'epub' }] });
      await backend.apply([{ type: 'addItem', item }]);
      return item;
    };
    const justice = await add('Ancillary Justice', ['sci-fi']);
    const sword = await add('Ancillary Sword', ['sci-fi']);
    const notes = await add('Notes', []);
    const device = createDevice({ name: 'X4', type: type.id, query: 'sci-fi' });
    await backend.apply([{ type: 'addDevice', device }, { type: 'addDeviceItems', id: device.id, itemIds: [notes.id] }]);
    const target = new FakeDevice();

    await sync(backend, device.id, target);
    expect([...target.files.keys()].sort()).toEqual([
      '/Books/Ancillary Justice - Ann Leckie.epub',
      '/Books/Ancillary Sword - Ann Leckie.epub',
      '/Books/Notes - Ann Leckie.epub',
    ]);

    // A book that stops matching comes off; one chosen by hand stays whatever its tags.
    await backend.apply([
      { type: 'removeTags', id: sword.id, tags: ['sci-fi'] },
      { type: 'addTags', id: justice.id, tags: ['read'] },
    ]);
    const { plan } = await sync(backend, device.id, target);
    expect(plan.removals).toEqual(['/Books/Ancillary Sword - Ann Leckie.epub']);
    expect([...target.files.keys()].sort()).toEqual(['/Books/Ancillary Justice - Ann Leckie.epub', '/Books/Notes - Ann Leckie.epub']);
  });
});
