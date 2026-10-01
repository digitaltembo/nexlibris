import { describe, expect, it } from 'vitest';
import { hashBlob, StoredLibraryBackend } from './backend';
import { createItem } from './operations';
import { MemoryStorage } from './storage';

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
