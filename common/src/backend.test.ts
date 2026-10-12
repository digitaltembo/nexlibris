import { describe, expect, it } from 'vitest';
import { hashBlob, StoredLibraryBackend } from './backend';
import { migrateLibrary, migrateOperation, NewerSchemaError } from './migrate';
import { applyOperations, createCategory, createDevice, createItem, createLibrary } from './operations';
import { MemoryStorage } from './storage';
import { positionKey } from './merge';
import { LOCAL_USER, SCHEMA_VERSION } from './types';

describe('StoredLibraryBackend', () => {
  it('persists the library and change log across instances', async () => {
    const storage = new MemoryStorage();
    const backend = new StoredLibraryBackend(storage);
    const item = createItem({ title: 'Neuromancer' });
    await backend.apply([{ type: 'addItem', item }]);
    await backend.apply([{ type: 'updateItem', id: item.id, patch: { title: 'Count Zero' } }]);

    const reopened = new StoredLibraryBackend(storage);
    const library = await reopened.getLibrary();
    expect(library.revision).toBe(2);
    expect(library.items[item.id]?.title).toBe('Count Zero');
    expect((await reopened.getChanges(1)).map((c) => c.op.type)).toEqual(['updateItem']);
  });

  it('leaves storage untouched when an operation fails', async () => {
    const storage = new MemoryStorage();
    const backend = new StoredLibraryBackend(storage);
    await expect(backend.apply([{ type: 'removeItem', id: 'missing' }])).rejects.toThrow();
    expect(await backend.getChanges(0)).toEqual([]);
    expect((await backend.getLibrary()).revision).toBe(0);
  });

  it('serializes concurrent applies', async () => {
    const backend = new StoredLibraryBackend(new MemoryStorage());
    await Promise.all(
      Array.from({ length: 5 }, (_, i) => backend.apply([{ type: 'addItem', item: createItem({ title: `${i}` }) }])),
    );
    expect(Object.keys((await backend.getLibrary()).items)).toHaveLength(5);
    expect((await backend.getChanges(0)).map((c) => c.revision)).toEqual([1, 2, 3, 4, 5]);
  });

  it('stores files by content hash', async () => {
    const backend = new StoredLibraryBackend(new MemoryStorage());
    const blob = new Blob(['hello']);
    const { hash, size } = await backend.putFile(blob);
    expect(hash).toBe(await hashBlob(new Blob(['hello'])));
    expect(hash).toBe('2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824');
    expect(size).toBe(5);
    expect(await (await backend.getFile(hash))?.text()).toBe('hello');
  });
});

describe('loading a stored library', () => {
  const setup = async () => {
    const storage = new MemoryStorage();
    const first = new StoredLibraryBackend(storage);
    const dune = createItem({ title: 'Dune' });
    const emma = createItem({ title: 'Emma' });
    await first.apply([{ type: 'addItem', item: dune }]);
    return { storage, dune, emma };
  };

  it('replays logged changes the snapshot lacks (a crash between logging and saving)', async () => {
    const { storage, dune, emma } = await setup();
    const snapshot = (await storage.readText('library.json'))!;
    await new StoredLibraryBackend(storage).apply([{ type: 'addItem', item: emma }]);
    // As if the app stopped after logging Emma but before saving the snapshot.
    await storage.writeText('library.json', snapshot);

    const library = await new StoredLibraryBackend(storage).getLibrary();
    expect(Object.keys(library.items).sort()).toEqual([dune.id, emma.id].sort());
    expect(library.revision).toBe(2);
    // Saved, so it's not replayed again.
    expect(JSON.parse((await storage.readText('library.json'))!).revision).toBe(2);
  });

  it('ignores a log line cut short by a crash', async () => {
    const { storage, dune } = await setup();
    await storage.appendText('changes.jsonl', '{"revision":2,"at":"2026-');
    const backend = new StoredLibraryBackend(storage);
    expect(Object.keys((await backend.getLibrary()).items)).toEqual([dune.id]);
    expect((await backend.getChanges(0)).map((c) => c.revision)).toEqual([1]);
  });

  it('refuses a library from a newer version instead of misreading it', async () => {
    const { storage } = await setup();
    const stored = JSON.parse((await storage.readText('library.json'))!);
    await storage.writeText('library.json', JSON.stringify({ ...stored, schemaVersion: SCHEMA_VERSION + 1 }));
    await expect(new StoredLibraryBackend(storage).getLibrary()).rejects.toBeInstanceOf(NewerSchemaError);
  });
});

describe('change IDs (schema 2)', () => {
  it('records this instance as the origin of its changes, numbered by revision', async () => {
    const storage = new MemoryStorage();
    const backend = new StoredLibraryBackend(storage);
    const { origin } = await backend.getLibrary();
    expect(origin).toMatch(/^[0-9a-f-]{36}$/);
    await backend.apply([{ type: 'addItem', item: createItem({ title: 'Dune' }) }]);
    await backend.apply([{ type: 'addItem', item: createItem({ title: 'Emma' }) }]);
    expect((await backend.getChanges(0)).map((c) => [c.origin, c.seq])).toEqual([
      [origin, 1],
      [origin, 2],
    ]);
    // Each new library is its own instance.
    expect((await new StoredLibraryBackend(new MemoryStorage()).getLibrary()).origin).not.toBe(origin);
  });

  it('gives a schema 1 library an origin, and its logged changes IDs, without rewriting the log', async () => {
    const storage = new MemoryStorage();
    const dune = createItem({ title: 'Dune' });
    const { origin: _, ...v1 } = { ...createLibrary('Old'), schemaVersion: 1, revision: 1, items: { [dune.id]: dune } };
    const v1Log = JSON.stringify({ revision: 1, at: '2026-01-01T00:00:00.000Z', op: { type: 'addItem', item: dune } }) + '\n';
    await storage.writeText('library.json', JSON.stringify(v1));
    await storage.appendText('changes.jsonl', v1Log);

    const backend = new StoredLibraryBackend(storage);
    const library = await backend.getLibrary();
    expect(library.schemaVersion).toBe(SCHEMA_VERSION);
    expect(library.origin).toMatch(/^[0-9a-f-]{36}$/);
    await backend.apply([{ type: 'updateItem', id: dune.id, patch: { title: 'Dune Messiah' } }]);

    // The old lines are left as they were; the new one is appended with its ID.
    expect((await storage.readText('changes.jsonl'))!.startsWith(v1Log)).toBe(true);
    // The origin is saved with the migrated library, so it's the same once reopened.
    const reopened = new StoredLibraryBackend(storage);
    expect((await reopened.getLibrary()).origin).toBe(library.origin);
    expect((await reopened.getChanges(0)).map((c) => [c.origin, c.seq, c.revision])).toEqual([
      [library.origin, 1, 1],
      [library.origin, 2, 2],
    ]);
  });

  it('keeps local files under local/, outside the library, and refuses other paths', async () => {
    const storage = new MemoryStorage();
    const backend = new StoredLibraryBackend(storage);
    await backend.writeLocalFile('thumbs/ab/abcd.jpg', new Blob(['jpeg']));
    expect(await (await backend.readLocalFile('thumbs/ab/abcd.jpg'))?.text()).toBe('jpeg');
    expect(await storage.exists('local/thumbs/ab/abcd.jpg')).toBe(true);
    expect(await backend.readLocalFile('thumbs/ab/missing.jpg')).toBeUndefined();
    for (const path of ['thumbs', '../library.json', 'thumbs/../../library.json', 'thumbs/.hidden', '/thumbs/a', 'Thumbs/a']) {
      expect(() => backend.readLocalFile(path)).toThrow('Bad local file path');
    }
  });
});

describe('migrateLibrary', () => {
  it('takes a schema 2 library to schema 3 unchanged, and then it takes categories', () => {
    const v2 = { ...createLibrary('Mine'), schemaVersion: 2 };
    const library = migrateLibrary(JSON.parse(JSON.stringify(v2)));
    expect(library).toEqual({ ...v2, schemaVersion: SCHEMA_VERSION });
    const category = createCategory({ name: 'Moods', entries: [{ label: 'Cosy', query: 'tag:cosy' }] });
    expect(applyOperations(library, [{ type: 'setCategory', category }]).library.categories).toEqual({ [category.id]: category });
  });

  it('takes a schema 3 library to schema 4 with its metadata normalized, and its logged operations', () => {
    const item = { ...createItem({ title: 'Dune' }), metadata: { published: '1965-07-31T23:00:00+00:00', seriesIndex: '1', pages: '412', mood: 'sandy', blank: '' } };
    const v3 = { ...createLibrary('Mine'), schemaVersion: 3, items: { [item.id]: item } };
    const library = migrateLibrary(JSON.parse(JSON.stringify(v3)));
    expect(library.schemaVersion).toBe(SCHEMA_VERSION);
    expect(library.items[item.id]!.metadata).toEqual({ published: '1965-08-01', seriesIndex: 1, pages: 412, mood: 'sandy' });
    expect(migrateOperation({ type: 'setMetadata', id: item.id, key: 'published', value: 'June 1990' }, 3)).toEqual({
      type: 'setMetadata',
      id: item.id,
      key: 'published',
      value: '1990-06',
    });
  });

  it('takes a schema 4 library to schema 5 unchanged (placed files may now be marked linked)', () => {
    const v4 = { ...createLibrary('Mine'), schemaVersion: 4 };
    expect(migrateLibrary(JSON.parse(JSON.stringify(v4)))).toEqual({ ...v4, schemaVersion: SCHEMA_VERSION });
  });

  it('takes a schema 5 library to schema 6 unchanged, and then devices can keep items off', () => {
    const item = createItem({ title: 'Dune' });
    const device = createDevice({ name: 'Phone', type: 'nexlibris.instance', query: 'has:file' });
    const v5 = { ...createLibrary('Mine'), schemaVersion: 5, items: { [item.id]: item }, devices: { [device.id]: device } };
    const library = migrateLibrary(JSON.parse(JSON.stringify(v5)));
    expect(library).toEqual({ ...v5, schemaVersion: SCHEMA_VERSION });
    const excluded = applyOperations(library, [{ type: 'excludeDeviceItems', id: device.id, itemIds: [item.id, 'elsewhere', item.id] }]).library;
    expect(excluded.devices![device.id]!.excluded).toEqual([item.id, 'elsewhere']);
    const back = applyOperations(excluded, [{ type: 'unexcludeDeviceItems', id: device.id, itemIds: [item.id, 'elsewhere'] }]).library;
    expect(back.devices![device.id]).toEqual(device);
  });

  it('takes a schema 6 library to schema 7 unchanged, and then dates can be before AD 1', () => {
    const item = createItem({ title: 'Lyrics', metadata: { originallyPublished: '1904' } });
    const v6 = { ...createLibrary('Mine'), schemaVersion: 6, items: { [item.id]: item } };
    const library = migrateLibrary(JSON.parse(JSON.stringify(v6)));
    expect(library).toEqual({ ...v6, schemaVersion: SCHEMA_VERSION });
    const older = applyOperations(library, [{ type: 'setMetadata', id: item.id, key: 'originallyPublished', value: '570 BC' }]).library;
    expect(older.items[item.id]!.metadata.originallyPublished).toBe('-0570');
  });

  it('takes a schema 7 library to schema 8 unchanged; a position set aside keeps its place, and syncs', () => {
    const item = createItem({ title: 'Emma' });
    const read = applyOperations({ ...createLibrary('Mine'), items: { [item.id]: item } }, [
      { type: 'setPosition', userId: LOCAL_USER, itemId: item.id, position: { hash: 'h', locator: 'epubcfi(/6/4)', progress: 0.3 } },
    ]).library;
    const v7 = { ...read, schemaVersion: 7 };
    const library = migrateLibrary(JSON.parse(JSON.stringify(v7)));
    expect(library).toEqual({ ...v7, schemaVersion: SCHEMA_VERSION });
    const position = { hash: 'h', locator: 'epubcfi(/6/4)', progress: 0.3 };
    const aside = applyOperations(library, [
      { type: 'setPosition', userId: LOCAL_USER, itemId: item.id, position: { ...position, setAside: true } },
    ]).library;
    expect(aside.userData[LOCAL_USER]!.positions![item.id]).toMatchObject({ ...position, setAside: true });
    // A merge tells it from the position it was, and carries the mark.
    expect(positionKey(aside.userData[LOCAL_USER]!.positions![item.id])).not.toEqual(positionKey(library.userData[LOCAL_USER]!.positions![item.id]));
  });

  it('runs each step from the stored version up', () => {
    const migrations = {
      1: { library: (l: Record<string, unknown>) => ({ ...l, shelves: [] }) },
      2: {
        library: (l: Record<string, unknown>) => ({ ...l, renamed: l.name, name: undefined }),
        operation: (op: Record<string, unknown>) => (op.type === 'old' ? { ...op, type: 'new' } : op),
      },
    };
    const library = { ...createLibrary('Mine'), schemaVersion: 1 };
    expect(migrateLibrary(library, migrations, 3)).toMatchObject({ schemaVersion: 3, shelves: [], renamed: 'Mine' });
    expect(migrateOperation({ type: 'old' } as never, 1, migrations, 3)).toEqual({ type: 'new' });
    expect(() => migrateLibrary({ ...library, schemaVersion: 4 }, migrations, 3)).toThrow(NewerSchemaError);
    expect(() => migrateLibrary({ name: 'not a library' })).toThrow('This is not a nexlibris library.');
  });
});
