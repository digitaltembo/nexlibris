import { createItem, LOCAL_USER, MemoryStorage, StoredLibraryBackend, type LibraryBackend } from '@nexlibris/common';
import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import { exportLibrary, restoreLibrary } from './backup';

const newBackend = () => new StoredLibraryBackend(new MemoryStorage());

/** A library with a book (file + cover, rated and reviewed) and a file-less wishlist item. */
async function sampleLibrary(backend: LibraryBackend) {
  const file = await backend.putFile(new Blob(['the book']));
  const cover = await backend.putFile(new Blob(['the cover']));
  const book = createItem({
    title: 'Book',
    files: [{ ...file, format: 'epub', name: 'book.epub' }],
    cover: { hash: cover.hash, mediaType: 'image/jpeg' },
    tags: ['fiction'],
  });
  const wish = createItem({ title: 'Wishlist' });
  await backend.apply([
    { type: 'addItem', item: book },
    { type: 'addItem', item: wish },
    { type: 'setRating', userId: LOCAL_USER, itemId: book.id, rating: 4 },
    { type: 'setReview', userId: LOCAL_USER, itemId: book.id, text: 'Good.' },
    {
      type: 'setPosition',
      userId: LOCAL_USER,
      itemId: book.id,
      position: { hash: file.hash, locator: 'cfi', progress: 0.5 },
    },
  ]);
  return { book, wish };
}

/** A backup as one Blob, as a download would make it. */
async function backupZip(backend: LibraryBackend) {
  const backup = await exportLibrary(backend);
  const parts: BlobPart[] = [];
  for await (const part of backup.parts) parts.push(part as BlobPart);
  return { zip: new Blob(parts), missing: backup.missing };
}

describe('backups', () => {
  it('restore into an empty library reproduces items, files, covers, ratings, reviews and positions', async () => {
    const source = newBackend();
    const { book, wish } = await sampleLibrary(source);
    const { zip, missing } = await backupZip(source);
    expect(missing).toEqual([]);

    const target = newBackend();
    const result = await restoreLibrary(target, zip);
    expect(result.added.map((i) => i.title).sort()).toEqual(['Book', 'Wishlist']);
    expect(result.warnings).toEqual([]);

    const library = await target.getLibrary();
    expect(library.items[book.id]).toEqual(book);
    expect(library.items[wish.id]).toEqual(wish);
    expect(await (await target.getFile(book.files[0]!.hash))?.text()).toBe('the book');
    expect(await (await target.getFile(book.cover!.hash))?.text()).toBe('the cover');
    expect(library.userData[LOCAL_USER]?.ratings[book.id]).toBe(4);
    expect(library.userData[LOCAL_USER]?.reviews[book.id]?.text).toBe('Good.');
    expect(library.userData[LOCAL_USER]?.positions?.[book.id]).toMatchObject({ locator: 'cfi', progress: 0.5 });
  });

  it('merges: leaves existing items alone and skips items already present', async () => {
    const backend = newBackend();
    const { book } = await sampleLibrary(backend);
    const { zip } = await backupZip(backend);
    await backend.apply([{ type: 'updateItem', id: book.id, patch: { title: 'Renamed' } }]);

    const result = await restoreLibrary(backend, zip);
    expect(result.added).toEqual([]);
    expect(result.skipped).toHaveLength(2);
    expect((await backend.getLibrary()).items[book.id]?.title).toBe('Renamed');
  });

  it('skips an item whose file is already in the library under another item', async () => {
    const source = newBackend();
    await sampleLibrary(source);
    const { zip } = await backupZip(source);

    const target = newBackend();
    const file = await target.putFile(new Blob(['the book']));
    await target.apply([
      { type: 'addItem', item: createItem({ title: 'Mine', files: [{ ...file, format: 'epub' }] }) },
    ]);
    const result = await restoreLibrary(target, zip);
    expect(result.skipped.map((i) => i.title)).toEqual(['Book']);
    expect(result.added.map((i) => i.title)).toEqual(['Wishlist']);
  });

  it('restores items whose files are missing from the backup, without those files', async () => {
    const source = newBackend();
    const { book } = await sampleLibrary(source);
    const zip = await JSZip.loadAsync((await backupZip(source)).zip);
    zip.remove(`files/${book.files[0]!.hash}`);

    const target = newBackend();
    const result = await restoreLibrary(target, await zip.generateAsync({ type: 'blob' }));
    expect(result.warnings).toEqual(['Book: 1 file is missing from the backup']);
    const restored = (await target.getLibrary()).items[book.id]!;
    expect(restored.files).toEqual([]);
    expect(restored.cover).toEqual(book.cover);
  });

  it('reports files the library refers to but doesn’t have, and backs up the rest', async () => {
    const source = newBackend();
    await sampleLibrary(source);
    const ghost = createItem({ title: 'Ghost', files: [{ hash: 'f'.repeat(64), size: 3, format: 'epub' }] });
    await source.apply([{ type: 'addItem', item: ghost }]);
    const { zip, missing } = await backupZip(source);
    expect(missing).toEqual(['f'.repeat(64)]);
    const result = await restoreLibrary(newBackend(), zip);
    expect(result.added.map((i) => i.title).sort()).toEqual(['Book', 'Ghost', 'Wishlist']);
  });

  it('rejects files that are not backups', async () => {
    const target = newBackend();
    await expect(restoreLibrary(target, new Blob(['nope']))).rejects.toThrow('not a nexlibris backup');
    const zip = new JSZip();
    zip.file('nexlibris-backup.json', JSON.stringify({ format: 'nexlibris-backup', version: 99, library: {} }));
    await expect(restoreLibrary(target, await zip.generateAsync({ type: 'blob' }))).rejects.toThrow(
      'different version',
    );
  });
});
