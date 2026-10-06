import { createItem, MemoryStorage, StoredLibraryBackend, type Operation } from '@nexlibris/common';
import { describe, expect, it } from 'vitest';
import { removeFiles, removeFormat } from './freeFiles';

describe('removeFormat', () => {
  it('takes a format’s files off the items, deleting those nothing else uses', async () => {
    const backend = new StoredLibraryBackend(new MemoryStorage());
    const mobi = await backend.putFile(new Blob(['mobi']));
    const shared = await backend.putFile(new Blob(['shared mobi']));
    const epub = await backend.putFile(new Blob(['epub']));
    const x4 = await backend.putFile(new Blob(['x4']));
    const dune = createItem({
      title: 'Dune',
      files: [
        { ...mobi, format: 'mobi' },
        { ...epub, format: 'epub' },
        { ...x4, format: 'x4.epub', derivedFrom: { hash: epub.hash, converter: 'xteink', converterVersion: '1' } },
      ],
    });
    const emma = createItem({ title: 'Emma', files: [{ ...shared, format: 'mobi' }] });
    const other = createItem({ title: 'Emma again', files: [{ ...shared, format: 'mobi' }] });
    await backend.apply([dune, emma, other].map((item): Operation => ({ type: 'addItem', item })));

    const result = await removeFormat(backend, (ops) => backend.apply(ops), [dune, emma], 'mobi');
    expect(result).toMatchObject({ removed: 2, files: 1 });
    const library = await backend.getLibrary();
    expect(library.items[dune.id]!.files.map((f) => f.format)).toEqual(['epub', 'x4.epub']);
    expect(library.items[emma.id]!.files).toEqual([]);
    expect(await backend.hasFile(mobi.hash)).toBe(false);
    // Still another item's.
    expect(await backend.hasFile(shared.hash)).toBe(true);

    // Removing the EPUBs leaves the X4 copy as a file of its own.
    await removeFormat(backend, (ops) => backend.apply(ops), [library.items[dune.id]!], 'epub');
    expect((await backend.getLibrary()).items[dune.id]!.files).toEqual([{ ...x4, format: 'x4.epub' }]);
  });

  it('removes one file of a book, as the book’s Remove button does', async () => {
    const backend = new StoredLibraryBackend(new MemoryStorage());
    const pdf = await backend.putFile(new Blob(['pdf']));
    const epub = await backend.putFile(new Blob(['epub']));
    const dune = createItem({ title: 'Dune', files: [{ ...pdf, format: 'pdf' }, { ...epub, format: 'epub' }] });
    await backend.apply([{ type: 'addItem', item: dune }]);

    expect(await removeFiles(backend, (ops) => backend.apply(ops), [{ item: dune, hashes: [pdf.hash] }])).toMatchObject({ removed: 1, files: 1 });
    expect((await backend.getLibrary()).items[dune.id]!.files).toEqual([{ ...epub, format: 'epub' }]);
    expect(await backend.hasFile(pdf.hash)).toBe(false);
    expect(await backend.hasFile(epub.hash)).toBe(true);
  });
});
