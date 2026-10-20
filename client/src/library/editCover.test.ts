import { createItem, MemoryStorage, StoredLibraryBackend } from '@nexlibris/common';
import { describe, expect, it } from 'vitest';
import { coverFromFile, coverOperations } from './editCover';
import { freeFiles } from './freeFiles';

describe('editing a cover', () => {
  it('stores the new cover with its colour, and the old one is freed', async () => {
    const backend = new StoredLibraryBackend(new MemoryStorage());
    const old = await backend.putFile(new Blob(['old cover']));
    const item = createItem({ title: 'Dune', cover: { hash: old.hash, mediaType: 'image/jpeg' }, metadata: { coverColor: '#000000' } });
    await backend.apply([{ type: 'addItem', item }]);

    const ops = await coverOperations(backend, item, { data: new Blob(['new cover']), mediaType: 'image/png' }, async () => '#c08040');
    await backend.apply(ops);
    await freeFiles(backend, [item]);
    const saved = (await backend.getLibrary()).items[item.id]!;
    expect(saved.cover?.mediaType).toBe('image/png');
    expect(await backend.hasFile(saved.cover!.hash)).toBe(true);
    expect(saved.metadata.coverColor).toBe('#c08040');
    expect(await backend.hasFile(old.hash)).toBe(false);
  });

  it('changes nothing for the cover the item has', async () => {
    const backend = new StoredLibraryBackend(new MemoryStorage());
    const data = new Blob(['cover']);
    const item = createItem({ title: 'Dune', cover: { hash: (await backend.putFile(data)).hash, mediaType: 'image/jpeg' } });
    expect(await coverOperations(backend, item, { data, mediaType: 'image/jpeg' }, async () => '#ffffff')).toEqual([]);
  });

  it('takes only images from files', () => {
    expect(coverFromFile(new File(['x'], 'cover.png', { type: 'image/png' }))?.mediaType).toBe('image/png');
    expect(coverFromFile(new File(['x'], 'book.epub', { type: 'application/epub+zip' }))).toBeUndefined();
  });
});
