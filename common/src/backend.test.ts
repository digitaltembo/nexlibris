import { describe, expect, it } from 'vitest';
import { hashBlob, StoredLibraryBackend } from './backend';
import { migrateLibrary, migrateOperation, NewerSchemaError } from './migrate';
import { createItem, createLibrary } from './operations';
import { MemoryStorage } from './storage';
import { SCHEMA_VERSION } from './types';

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

describe('migrateLibrary', () => {
  it('runs each step from the stored version up', () => {
    const migrations = {
      1: { library: (l: Record<string, unknown>) => ({ ...l, shelves: [] }) },
      2: {
        library: (l: Record<string, unknown>) => ({ ...l, renamed: l.name, name: undefined }),
        operation: (op: Record<string, unknown>) => (op.type === 'old' ? { ...op, type: 'new' } : op),
      },
    };
    const library = createLibrary('Mine');
    expect(migrateLibrary(library, migrations, 3)).toMatchObject({ schemaVersion: 3, shelves: [], renamed: 'Mine' });
    expect(migrateOperation({ type: 'old' } as never, 1, migrations, 3)).toEqual({ type: 'new' });
    expect(() => migrateLibrary({ ...library, schemaVersion: 4 }, migrations, 3)).toThrow(NewerSchemaError);
    expect(() => migrateLibrary({ name: 'not a library' })).toThrow('This is not a nexlibris library.');
  });
});
