import { createItem, MemoryStorage, StoredLibraryBackend } from '@nexlibris/common';
import JSZip from 'jszip';
import { describe, expect, it, vi } from 'vitest';
import { importFiles } from './importFiles';
import { metadataToText, textToMetadata } from './metadataText';
import { availableFields, visibleColumns } from './columns';
import { filterItems, sortItems } from './search';

async function epubFile(name: string, title: string, extra = ''): Promise<File> {
  const zip = new JSZip();
  zip.file('mimetype', 'application/epub+zip');
  zip.file(
    'META-INF/container.xml',
    `<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="content.opf"/></rootfiles></container>`,
  );
  zip.file(
    'content.opf',
    `<package xmlns="http://www.idpf.org/2007/opf"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>${title}</dc:title>${extra}</metadata></package>`,
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

  it('makes one item of the formats of one book, taking metadata from the best format', async () => {
    const backend = new StoredLibraryBackend(new MemoryStorage());
    const files = [
      await epubFile('dune.x4.epub', 'Dune (X4)'),
      await epubFile('dune.epub', 'Dune'),
      new File(['Dune, as text.'], 'Dune.txt'),
      await epubFile('emma.epub', 'Emma'),
    ];
    const progress: number[] = [];
    let saves = 0;
    const result = await importFiles(backend, files, { onProgress: (done) => progress.push(done), onSaved: () => saves++ });

    expect(result.added.map((i) => [i.title, i.files.map((f) => f.format)])).toEqual([
      ['Dune', ['epub', 'txt', 'x4.epub']],
      ['Emma', ['epub']],
    ]);
    expect(progress).toEqual([3, 4]);
    expect(saves).toBe(1);
    // A text file has no author to match an item by, so it's a new item; exact duplicates are skipped.
    const again = await importFiles(backend, [files[1]!, new File(['Dune, again.'], 'dune.txt')]);
    expect(again.added.map((i) => i.files.map((f) => f.name))).toEqual([['dune.txt']]);
    expect(again.skipped).toEqual([{ name: 'dune.epub', reason: 'already in the library' }]);
  });

  it('adds files to the book already in the library, matched by ISBN or by title and author', async () => {
    const backend = new StoredLibraryBackend(new MemoryStorage());
    // Added by ISBN, so no file yet.
    const scanned = createItem({ title: 'Dune', identifiers: { isbn: '9780441172719' } });
    const emma = createItem({ title: 'Emma', creators: [{ name: 'Jane Austen', role: 'aut' }] });
    await backend.apply([{ type: 'addItem', item: scanned }, { type: 'addItem', item: emma }]);

    const author = (name: string) => `<dc:creator>${name}</dc:creator>`;
    const result = await importFiles(backend, [
      await epubFile('dune-ace.epub', 'Dune (Ace edition)', '<dc:identifier>urn:isbn:0-441-17271-7</dc:identifier>'),
      await epubFile('emma.epub', 'EMMA!', author('Jane Austen')),
      await epubFile('emma-other.epub', 'Emma', author('Someone Else')),
    ]);

    expect(result.added.map((i) => i.title)).toEqual(['Emma']);
    expect(result.merged.map((m) => [m.item.title, m.names])).toEqual([
      ['Dune', ['dune-ace.epub']],
      ['Emma', ['emma.epub']],
    ]);
    const library = await backend.getLibrary();
    expect(library.items[scanned.id]!.files.map((f) => f.name)).toEqual(['dune-ace.epub']);
    // The item's own details stay as they were.
    expect(library.items[scanned.id]!.title).toBe('Dune');
    expect(library.items[emma.id]!.files.map((f) => f.name)).toEqual(['emma.epub']);

    // A book that already has an EPUB gets a second, different one as a new item (likely another edition).
    const again = await importFiles(backend, [await epubFile('emma-2.epub', 'Emma', `${author('Jane Austen')}<dc:date>2003</dc:date>`)]);
    expect(again.merged).toEqual([]);
    expect(again.added.map((i) => i.title)).toEqual(['Emma']);
  });

  it('imports files the native app already stored without storing them again', async () => {
    const backend = new StoredLibraryBackend(new MemoryStorage());
    const epub = await epubFile('dune.epub', 'Dune');
    const stored = await backend.putFile(epub);
    const putFile = vi.spyOn(backend, 'putFile');
    const result = await importFiles(backend, [{ name: 'dune.epub', stored, arrayBuffer: () => epub.arrayBuffer() }]);
    expect(result.added).toMatchObject([{ title: 'Dune', files: [{ hash: stored.hash, size: stored.size, name: 'dune.epub' }] }]);
    expect(putFile).not.toHaveBeenCalled();
  });

    it('keeps the readable formats of a book when one of them is broken', async () => {
    const backend = new StoredLibraryBackend(new MemoryStorage());
    const result = await importFiles(backend, [new File(['junk'], 'b.epub'), new File(['text'], 'b.txt')]);
    expect(result.added.map((i) => [i.title, i.files.map((f) => f.format)])).toEqual([['b', ['txt']]]);
    expect(result.skipped).toMatchObject([{ name: 'b.epub' }]);
  });
});

describe('filterItems and sortItems', () => {
  const dune = createItem({ title: 'Dune', creators: [{ name: 'Frank Herbert', role: 'aut' }], tags: ['desert'] });
  const emma = createItem({ title: 'Emma', creators: [{ name: 'Jane Austen', role: 'aut' }] });

  it('matches every word across title, creators, tags and metadata', () => {
    expect(filterItems([dune, emma], 'herbert desert')).toEqual([dune]);
    expect(filterItems([dune, emma], 'austen desert')).toEqual([]);
  });

  it('matches the starts of words, ignoring case, accents and punctuation', () => {
    const verne = createItem({ title: 'Vingt mille lieues sous les mers', creators: [{ name: 'Jules Verne', role: 'aut' }] });
    const screw = createItem({ title: 'The Turn of the Screw', metadata: { description: 'A governess in summer.' } });
    const hugo = createItem({ title: 'Les Misérables', creators: [{ name: 'Victor Hugo', role: 'aut' }] });
    const montgomery = createItem({ title: 'Anne of Green Gables', creators: [{ name: 'L.M. Montgomery', role: 'aut' }] });
    const all = [verne, screw, hugo, montgomery];
    expect(filterItems(all, 'verne mer')).toEqual([verne]);
    expect(filterItems(all, 'MISERABLES')).toEqual([hugo]);
    expect(filterItems(all, 'misé')).toEqual([hugo]);
    expect(filterItems(all, 'l.m. montgomery')).toEqual([montgomery]);
    expect(filterItems(all, '  ')).toEqual(all);
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
