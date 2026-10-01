import { createItem, MemoryStorage, StoredLibraryBackend } from '@nexlibris/common';
import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import { importFiles } from './importFiles';
import { metadataToText, textToMetadata } from './metadataText';
import { availableFields, visibleColumns } from './columns';
import { filterItems, sortItems } from './search';

async function epubFile(name: string, title: string): Promise<File> {
  const zip = new JSZip();
  zip.file('mimetype', 'application/epub+zip');
  zip.file(
    'META-INF/container.xml',
    `<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="content.opf"/></rootfiles></container>`,
  );
  zip.file(
    'content.opf',
    `<package xmlns="http://www.idpf.org/2007/opf"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>${title}</dc:title></metadata></package>`,
  );
  return new File([await zip.generateAsync({ type: 'blob' })], name);
}

describe('importFiles', () => {
  it('adds EPUBs as items with their file, skipping duplicates and other formats', async () => {
    const backend = new StoredLibraryBackend(new MemoryStorage());
    const book = await epubFile('a.epub', 'Book A');
    const result = await importFiles(backend, [book, new File(['x'], 'notes.doc'), book]);

    expect(result.added.map((i) => i.title)).toEqual(['Book A']);
    expect(result.skipped.map((s) => s.name)).toEqual(['notes.doc', 'a.epub']);
    const [item] = Object.values((await backend.getLibrary()).items);
    expect(item?.files).toMatchObject([{ format: 'epub', name: 'a.epub', size: book.size }]);
    expect(await backend.getFile(item!.files[0]!.hash)).toBeDefined();

    const again = await importFiles(backend, [book]);
    expect(again.added).toEqual([]);
  });

  it('imports plain text titled by filename', async () => {
    const backend = new StoredLibraryBackend(new MemoryStorage());
    const result = await importFiles(backend, [new File(['Call me Ishmael.'], 'moby_dick.txt')]);
    expect(result.added).toMatchObject([{ title: 'moby dick', files: [{ format: 'txt' }] }]);
  });

  it('reports unreadable EPUBs without aborting the rest', async () => {
    const backend = new StoredLibraryBackend(new MemoryStorage());
    const result = await importFiles(backend, [new File(['junk'], 'broken.epub'), await epubFile('b.epub', 'Book B')]);
    expect(result.added.map((i) => i.title)).toEqual(['Book B']);
    expect(result.skipped).toMatchObject([{ name: 'broken.epub' }]);
  });
});

describe('filterItems and sortItems', () => {
  const dune = createItem({ title: 'Dune', creators: [{ name: 'Frank Herbert', role: 'aut' }], tags: ['desert'] });
  const emma = createItem({ title: 'Emma', creators: [{ name: 'Jane Austen', role: 'aut' }] });

  it('matches every word across title, creators, tags and metadata', () => {
    expect(filterItems([dune, emma], 'herbert desert')).toEqual([dune]);
    expect(filterItems([dune, emma], 'austen desert')).toEqual([]);
  });

  it('sorts in either direction, with missing values last', () => {
    const titles = (items: { title: string }[]) => items.map((i) => i.title);
    expect(titles(sortItems([emma, dune], { key: 'title', desc: false }))).toEqual(['Dune', 'Emma']);
    expect(titles(sortItems([dune, emma], { key: 'title', desc: true }))).toEqual(['Emma', 'Dune']);
    expect(titles(sortItems([dune, emma], { key: 'author', desc: false }))).toEqual(['Dune', 'Emma']);
    expect(titles(sortItems([dune, emma], { key: 'rating', desc: true }, { [emma.id]: 3 }))).toEqual(['Emma', 'Dune']);
    expect(titles(sortItems([dune, emma], { key: 'rating', desc: false }, { [emma.id]: 3 }))).toEqual(['Emma', 'Dune']);
  });
});

describe('metadata text', () => {
  it('round-trips strings, string lists and numbers', () => {
    expect(textToMetadata(metadataToText(['a', 'b']), ['x'])).toEqual(['a', 'b']);
    expect(textToMetadata('3', 2)).toBe(3);
    expect(textToMetadata('1984', 'old title')).toBe('1984');
    expect(textToMetadata('anything', undefined)).toBe('anything');
  });
});

describe('list columns', () => {
  it('offers fields used in the library, except ones with their own column', () => {
    const items = [
      createItem({ title: 'A', metadata: { publisher: 'X', series: 'S', seriesIndex: 1 } }),
      createItem({ title: 'B', metadata: { language: 'en', publisher: 'Y' } }),
    ];
    expect(availableFields(items)).toEqual(['language', 'publisher']);
  });

  it('orders visible columns stably and drops unknown ones', () => {
    expect(visibleColumns(['field:publisher', 'rating', 'bogus', 'field:gone', 'cover'], ['language', 'publisher'])).toEqual([
      'cover',
      'rating',
      'field:publisher',
    ]);
  });
});
