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
import { listDevice, planSync, type PlanOptions } from './plan';
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

async function sync(backend: StoredLibraryBackend, deviceId: string, target: FakeDevice, deviceType = type, options?: PlanOptions) {
  const library = await backend.getLibrary();
  const device = library.devices![deviceId]!;
  const plan = planSync(library, device, deviceType, await listDevice(device, deviceType, target), options);
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
    // Not taking copies already there, one where a book goes is in the way.
    const refused = planSync(await backend.getLibrary(), (await backend.getLibrary()).devices![deviceId]!, type, await listDevice((await backend.getLibrary()).devices![deviceId]!, type, target), { keepFound: false });
    expect(refused.conflicts).toMatchObject([{ path: '/Books/Dune - Frank Herbert.epub' }]);
    // Taking them, it's Dune's copy, kept as it is.
    const first = await sync(backend, deviceId, target);
    expect(first.plan.conflicts).toEqual([]);
    expect(first.plan.kept.map((k) => k.path)).toEqual(['/Books/Dune - Frank Herbert.epub']);
    expect(first.result).toMatchObject({ sent: 1, kept: 1 });
    expect(target.files.get('/Books/Dune - Frank Herbert.epub')).toBe('my own copy');

    // Edited on the device: no longer the sync's, so it's neither replaced nor removed.
    target.files.set('/Books/Emma A Novel - Jane Austen.epub', 'emma, annotated on the device');
    await backend.apply([{ type: 'removeDeviceItems', id: deviceId, itemIds: [emma.id] }]);
    const second = await sync(backend, deviceId, target);
    expect(second.plan.removals).toEqual([]);
    expect(Object.keys(second.device.placed)).toEqual(['/Books/Dune - Frank Herbert.epub']);
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

/** A device that can move files, and keeps folders, which it removes only when empty. */
class MovingDevice extends FakeDevice {
  moves: string[] = [];
  async move(from: string, to: string) {
    if (!this.folders.has(to.slice(0, to.lastIndexOf('/')))) throw new Error(`no folder for ${to}`);
    this.files.set(to, this.files.get(from)!);
    this.files.delete(from);
    this.moves.push(`${from} → ${to}`);
  }
  override async remove(path: string) {
    if (this.files.delete(path)) return;
    const inside = (p: string) => p.startsWith(`${path}/`);
    if ([...this.files.keys(), ...this.folders].some(inside)) throw new Error('Folder is not empty');
    this.folders.delete(path);
  }
}

describe('device sync with path templates', () => {
  const templated = (folder: string, fileName?: string): DeviceType => ({
    ...type,
    folder: () => folder,
    ...(fileName && { fileName: () => fileName }),
  });
  const syncWith = async (backend: StoredLibraryBackend, deviceId: string, target: FakeDevice, deviceType: DeviceType) => {
    const library = await backend.getLibrary();
    const device = library.devices![deviceId]!;
    const plan = planSync(library, device, deviceType, await listDevice(device, deviceType, target, library));
    const result = await runSync(deviceId, plan, target, backend, undefined);
    await backend.apply(result.operations);
    return { plan, result };
  };

  it('puts books where the templates say, and moves them when the templates change', async () => {
    const { backend, deviceId } = await setup();
    const target = new MovingDevice();
    await syncWith(backend, deviceId, target, templated('/library/<author>/<title>/'));
    expect([...target.files.keys()]).toEqual([
      '/library/Frank Herbert/Dune/Dune - Frank Herbert.epub',
      '/library/Jane Austen/Emma A Novel/Emma A Novel - Jane Austen.epub',
    ]);

    const { plan, result } = await syncWith(backend, deviceId, target, templated('/library/<authorSort>', '<title>'));
    expect(plan.uploads).toEqual([]);
    expect(target.moves).toEqual([
      '/library/Frank Herbert/Dune/Dune - Frank Herbert.epub → /library/Herbert, Frank/Dune.epub',
      '/library/Jane Austen/Emma A Novel/Emma A Novel - Jane Austen.epub → /library/Austen, Jane/Emma A Novel.epub',
    ]);
    expect(result).toMatchObject({ sent: 0, moved: 2, removed: 0, errors: [] });
    // The folders they left are gone (the fake makes only the folders asked for, not their parents).
    expect([...target.folders].filter((f) => f.startsWith('/library')).sort()).toEqual(['/library/Austen, Jane', '/library/Herbert, Frank']);

    const again = await syncWith(backend, deviceId, target, templated('/library/<authorSort>', '<title>'));
    expect(again.plan).toMatchObject({ uploads: [], moves: [], removals: [], unchanged: 2 });
  });

  it('sends books again where the device can’t move them', async () => {
    const { backend, deviceId } = await setup();
    const target = new FakeDevice();
    await syncWith(backend, deviceId, target, templated('/Books'));
    const { plan } = await syncWith(backend, deviceId, target, templated('/Books/<author>'));
    expect(plan.moves).toEqual([]);
    expect(plan.uploads.map((u) => [u.path, u.supersedes])).toEqual([
      ['/Books/Frank Herbert/Dune - Frank Herbert.epub', '/Books/Dune - Frank Herbert.epub'],
      ['/Books/Jane Austen/Emma A Novel - Jane Austen.epub', '/Books/Emma A Novel - Jane Austen.epub'],
    ]);
    expect([...target.files.keys()].sort()).toEqual(['/Books/Frank Herbert/Dune - Frank Herbert.epub', '/Books/Jane Austen/Emma A Novel - Jane Austen.epub']);
  });

  it('leaves alone a file it didn’t send at a book’s new path that isn’t that book', async () => {
    const { backend, deviceId, dune } = await setup();
    const target = new MovingDevice();
    target.files.set('/Books/Frank Herbert/Dune - Frank Herbert.pdf', 'a pdf');
    const typePdf: DeviceType = { ...templated('/Books/<author>'), formats: ['pdf', 'epub'] };
    await backend.apply([{ type: 'attachFile', id: dune.id, file: { ...(await backend.putFile(new Blob(['dune pdf']))), format: 'pdf' } }]);
    const library = await backend.getLibrary();
    const device = library.devices![deviceId]!;
    const plan = planSync(library, device, typePdf, await listDevice(device, typePdf, target, library), { keepFound: false });
    expect(plan.conflicts).toEqual([{ path: '/Books/Frank Herbert/Dune - Frank Herbert.pdf', itemId: dune.id, reason: 'A file nexlibris didn’t send is already there.' }]);
  });

  it('takes copies of chosen books already on the device as theirs, moving them where they go', async () => {
    const { backend, deviceId, dune, emma } = await setup();
    const target = new MovingDevice();
    target.folders.add('/Calibre/Herbert');
    target.files.set('/Calibre/Herbert/Dune.epub', 'dune from calibre');
    target.files.set('/library/Jane Austen/Emma A Novel.epub', 'emma from calibre');
    target.files.set('/Calibre/Stranger.epub', 'not in the library');
    const deviceType = templated('/library/<author>', '<title>');
    const library = await backend.getLibrary();
    const device = library.devices![deviceId]!;
    const listing = await listDevice(device, deviceType, target, library);
    // The device's index knows Dune by its metadata, wherever it is; Emma is found by its name where it goes.
    const found = [
      { path: '/Calibre/Herbert/Dune.epub', size: 17, title: 'Dune', author: 'Frank Herbert' },
      { path: '/Calibre/Stranger.epub', size: 18, title: 'Stranger', author: 'Nobody' },
      ...listing.files,
    ];
    const plan = planSync(library, device, deviceType, { ...listing, found });
    expect(plan.uploads).toEqual([]);
    expect(plan.moves).toMatchObject([{ from: '/Calibre/Herbert/Dune.epub', to: '/library/Frank Herbert/Dune.epub', found: true }]);
    expect(plan.kept).toMatchObject([{ path: '/library/Jane Austen/Emma A Novel.epub', placed: { itemId: emma.id, found: true } }]);
    const result = await runSync(deviceId, plan, target, backend, undefined);
    await backend.apply(result.operations);
    expect(result).toMatchObject({ sent: 0, moved: 1, kept: 1, errors: [] });
    expect(target.files.get('/library/Frank Herbert/Dune.epub')).toBe('dune from calibre');
    expect(target.files.get('/Calibre/Stranger.epub')).toBe('not in the library');

    // Dune's library file is the optimized x4.epub, which the found copy stands for: nothing to do now.
    const again = await syncWith(backend, deviceId, target, deviceType);
    expect(again.plan).toMatchObject({ uploads: [], moves: [], kept: [], unchanged: 2 });
    // Once the library's file changes, nexlibris's copy replaces it.
    const { hash, size } = await backend.putFile(new Blob(['dune x4, second edition']));
    await backend.apply([
      { type: 'detachFile', id: dune.id, hash: dune.files.find((f) => f.format === 'x4.epub')!.hash },
      { type: 'attachFile', id: dune.id, file: { hash, size, format: 'x4.epub' } },
    ]);
    await syncWith(backend, deviceId, target, deviceType);
    expect(target.files.get('/library/Frank Herbert/Dune.epub')).toBe('dune x4, second edition');
  });

  it('takes found copies that need converting as current, rather than sending them again', async () => {
    const { backend, deviceId, emma } = await setup();
    const converter = { id: 'test.x4', version: 1, from: ['epub'], to: 'x4.epub' } as unknown as Converter;
    const converting: DeviceType = { ...type, makes: () => converter };
    const target = new MovingDevice();
    target.files.set('/Books/Emma A Novel - Jane Austen.epub', 'optimized elsewhere');
    const first = await sync(backend, deviceId, target, converting);
    expect(first.plan.kept).toMatchObject([{ placed: { itemId: emma.id, hash: emma.files[0]!.hash, found: true } }]);
    const second = await sync(backend, deviceId, target, converting);
    expect(second.plan.uploads).toEqual([]);
    expect(target.files.get('/Books/Emma A Novel - Jane Austen.epub')).toBe('optimized elsewhere');
  });
});
