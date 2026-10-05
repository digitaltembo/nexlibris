import { createItem, LOCAL_USER, MemoryStorage, StoredLibraryBackend } from '@nexlibris/common';
import JSZip from 'jszip';
import { describe, expect, it, vi } from 'vitest';
import { importFiles, type ImportSource } from './importFiles';
import { metadataToText, textToMetadata } from './metadataText';
import { availableFields, visibleColumns } from './columns';
import { filterItems, sortItems } from './search';
import { bookSize, sizeInMB } from './bookFields';

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

/** A file as picked with its folder, as a folder input or drop gives it. */
const inFolder = (path: string, data: Blob | string): ImportSource => {
  const blob = typeof data === 'string' ? new Blob([data]) : data;
  return { name: path.split('/').pop()!, webkitRelativePath: path, arrayBuffer: () => blob.arrayBuffer() };
};

/** A `metadata.opf` as Calibre writes it beside each book. */
const calibreOpf = (title: string, author: string, uuid: string, extra = '') => `<?xml version='1.0' encoding='utf-8'?>
<package xmlns="http://www.idpf.org/2007/opf" unique-identifier="uuid_id" version="2.0">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:opf="http://www.idpf.org/2007/opf">
    <dc:identifier opf:scheme="calibre" id="calibre_id">7</dc:identifier>
    <dc:identifier opf:scheme="uuid" id="uuid_id">${uuid}</dc:identifier>
    <dc:title>${title}</dc:title>
    <dc:creator opf:file-as="x" opf:role="aut">${author}</dc:creator>
    <dc:date>0101-01-01T00:00:00+00:00</dc:date>
    <dc:language>eng</dc:language>
    ${extra}
  </metadata>
  <guide><reference type="cover" title="Cover" href="cover.jpg"/></guide>
</package>`;

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
    const progress: (number | string)[][] = [];
    let saves = 0;
    const result = await importFiles(backend, files, {
      onProgress: (done, total, current) => progress.push(current ? [done, total, current] : [done, total]),
      onSaved: () => saves++,
    });

    expect(result.added.map((i) => [i.title, i.files.map((f) => f.format)])).toEqual([
      ['Dune', ['epub', 'txt', 'x4.epub']],
      ['Emma', ['epub']],
    ]);
    // Counted by book, each named as it's started.
    expect(progress).toEqual([
      [0, 2, 'dune.x4.epub'],
      [1, 2],
      [1, 2, 'emma.epub'],
      [2, 2],
    ]);
    expect(saves).toBe(1);
    // A text file has no author to match an item by, so it's a new item; exact duplicates are skipped.
    const again = await importFiles(backend, [files[1]!, new File(['Dune, again.'], 'dune.txt')]);
    expect(again.added.map((i) => i.files.map((f) => f.name))).toEqual([['dune.txt']]);
    expect(again.skipped).toEqual([{ name: 'dune.epub', reason: 'already in the library' }]);
  });

  it('stops before the next book when asked, keeping what it imported', async () => {
    const backend = new StoredLibraryBackend(new MemoryStorage());
    const stop = new AbortController();
    const files = [new File(['a'], 'a.txt'), new File(['b'], 'b.txt'), new File(['c'], 'c.txt')];
    const result = await importFiles(backend, files, { signal: stop.signal, onProgress: (done) => done === 1 && stop.abort() });
    expect(result.stopped).toBe(true);
    expect(result.added.map((i) => i.title)).toEqual(['a']);
    expect(Object.values((await backend.getLibrary()).items).map((i) => i.title)).toEqual(['a']);
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

  it('imports a Calibre library folder: one item per book folder, with its metadata.opf, cover and rating', async () => {
    const backend = new StoredLibraryBackend(new MemoryStorage());
    const dune = 'Calibre Library/Frank Herbert/Dune (7)';
    const messiah = 'Calibre Library/Frank Herbert/Dune Messiah (8)';
    const files = [
      inFolder('Calibre Library/metadata.db', 'sqlite'),
      inFolder('Calibre Library/metadata_db_prefs_backup.json', '{}'),
      inFolder('Calibre Library/.caltrash/b/old.epub', 'gone'),
      inFolder(`${dune}/Dune - Frank Herbert.epub`, await epubFile('x.epub', 'Dune (retail)', '<dc:publisher>Chilton</dc:publisher>')),
      // Named differently from the EPUB, but in the same book folder.
      inFolder(`${dune}/Dune.txt`, 'A beginning is the time.'),
      inFolder(`${dune}/cover.jpg`, 'jpeg'),
      inFolder(
        `${dune}/metadata.opf`,
        calibreOpf(
          'Dune',
          'Frank Herbert',
          'b0a6-dune',
          `<dc:subject>Science Fiction</dc:subject>
          <dc:identifier opf:scheme="ISBN">9780441013593</dc:identifier>
          <meta name="calibre:series" content="Dune"/><meta name="calibre:series_index" content="1.0"/>
          <meta name="calibre:rating" content="8.0"/><meta name="calibre:timestamp" content="2021-03-04T05:06:07+00:00"/>`,
        ),
      ),
      inFolder(`${messiah}/Dune Messiah - Frank Herbert.txt`, 'Twelve years.'),
      inFolder(`${messiah}/metadata.opf`, calibreOpf('Dune Messiah', 'Frank Herbert', 'c1d2-messiah', '<meta name="calibre:rating" content="0"/>')),
    ];
    const progress: number[] = [];
    const result = await importFiles(backend, files, { onProgress: (done) => progress.push(done) });

    expect(result.skipped).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(progress).toEqual([0, 1, 1, 2]);
    const [first, second] = result.added;
    expect(first).toMatchObject({
      title: 'Dune',
      creators: [{ name: 'Frank Herbert', role: 'aut' }],
      identifiers: { uuid: 'b0a6-dune', isbn: '9780441013593' },
      tags: ['Science Fiction'],
      // Calibre's metadata, with what only the file has.
      metadata: { series: 'Dune', seriesIndex: 1, language: 'eng', publisher: 'Chilton' },
      addedAt: '2021-03-04T05:06:07.000Z',
    });
    expect(first!.files.map((f) => f.format)).toEqual(['epub', 'txt']);
    expect(await (await backend.getFile(first!.cover!.hash))!.text()).toBe('jpeg');
    expect(second).toMatchObject({ title: 'Dune Messiah', identifiers: { uuid: 'c1d2-messiah' } });
    // Calibre's date for none isn't taken as the publication date.
    expect(second!.metadata.published).toBeUndefined();
    expect(second!.files.map((f) => f.format)).toEqual(['txt']);
    const library = await backend.getLibrary();
    expect(library.userData[LOCAL_USER]?.ratings).toEqual({ [first!.id]: 4 });

    // Imported again after adding a format in Calibre, the book gets the new format and nothing else.
    const again = await importFiles(backend, [
      ...files,
      inFolder(`${messiah}/Dune Messiah - Frank Herbert.epub`, await epubFile('y.epub', 'Messiah')),
    ]);
    expect(again.added).toEqual([]);
    expect(again.merged.map((m) => [m.item.title, m.names])).toEqual([['Dune Messiah', ['Dune Messiah - Frank Herbert.epub']]]);
  });

  it('matches a Calibre book to the item with its UUID, though its title was edited since', async () => {
    const backend = new StoredLibraryBackend(new MemoryStorage());
    const item = createItem({ title: 'Dune (1965)', identifiers: { uuid: 'B0A6-DUNE' }, files: [{ hash: 'h', size: 1, format: 'epub' }] });
    await backend.apply([{ type: 'addItem', item }]);
    const book = 'Calibre Library/Frank Herbert/Dune (7)';
    const result = await importFiles(backend, [
      inFolder(`${book}/Dune - Frank Herbert.txt`, 'A beginning.'),
      inFolder(`${book}/metadata.opf`, calibreOpf('Dune', 'Frank Herbert', 'b0a6-dune')),
    ]);
    expect(result.added).toEqual([]);
    expect(result.merged.map((m) => [m.item.id, m.names])).toEqual([[item.id, ['Dune - Frank Herbert.txt']]]);
  });

  it('groups formats in plain folders by name, and across folders by title and author', async () => {
    const backend = new StoredLibraryBackend(new MemoryStorage());
    const author = '<dc:creator>Jane Austen</dc:creator>';
    const result = await importFiles(backend, [
      inFolder('Books/epub/Emma.epub', await epubFile('Emma.epub', 'Emma', author)),
      inFolder('Books/x4/Austen - Emma.x4.epub', await epubFile('e.x4.epub', 'Emma', `${author}<dc:date>2025</dc:date>`)),
      inFolder('Books/pdf-and-text/emma.txt', 'Emma Woodhouse.'),
      inFolder('Books/pdf-and-text/emma.rtf', '{\\rtf1 Emma}'),
      inFolder('Books/pdf-and-text/notes.doc', 'no'),
      inFolder('Books/.DS_Store', ''),
    ]);
    // The text files have no author to match the EPUB by, so they stay a book of their own.
    expect(result.added.map((i) => [i.title, i.files.map((f) => f.format)])).toEqual([
      ['Emma', ['epub']],
      ['emma', ['rtf', 'txt']],
    ]);
    expect(result.merged.map((m) => [m.item.title, m.names])).toEqual([['Emma', ['Austen - Emma.x4.epub']]]);
    expect(result.skipped.map((s) => s.name)).toEqual(['notes.doc']);
  });

    it('keeps the readable formats of a book when one of them is broken', async () => {
    const backend = new StoredLibraryBackend(new MemoryStorage());
    const result = await importFiles(backend, [new File(['junk'], 'b.epub'), new File(['text'], 'b.txt')]);
    expect(result.added.map((i) => [i.title, i.files.map((f) => f.format)])).toEqual([['b', ['txt']]]);
    expect(result.skipped).toMatchObject([{ name: 'b.epub' }]);
  });
});

describe('filterItems and sortItems', () => {
  it('sizes a book by its largest file, as Calibre does, and sorts and searches by it', () => {
    const file = (size: number, format: string) => ({ hash: `${format}${size}`, size, format });
    const big = createItem({ title: 'Big', files: [file(2_500_000, 'epub'), file(9_000_000, 'pdf')] });
    const small = createItem({ title: 'Small', files: [file(40_000, 'epub')] });
    const none = createItem({ title: 'None' });
    expect(bookSize(big)).toBe(9_000_000);
    expect([big, small, none].map((i) => sizeInMB(bookSize(i)))).toEqual(['8.6', '<0.1', '0.0']);
    const titles = (items: { title: string }[]) => items.map((i) => i.title);
    expect(titles(sortItems([small, none, big], { key: 'size', desc: true }))).toEqual(['Big', 'Small', 'None']);
    expect(titles(sortItems([big, none, small], { key: 'size', desc: false }))).toEqual(['Small', 'Big', 'None']);
    expect(titles(filterItems([big, small, none], 'size:>2M'))).toEqual(['Big']);
    expect(titles(filterItems([big, small, none], 'size:<50k'))).toEqual(['Small']);
    expect(titles(filterItems([big, small, none], 'size:>=40000'))).toEqual(['Big', 'Small']);
  });

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

  it('sorts and searches first published with BC before AD', () => {
    const at = (title: string, originallyPublished: string) => createItem({ title, metadata: { originallyPublished } });
    const books = [at('Dune', '1965-08-01'), at('Metamorphoses', '0008'), at('Lyrics', '-0570'), at('Republic', '-0375'), at('Genji', '1021')];
    const titles = (items: { title: string }[]) => items.map((i) => i.title);
    expect(titles(sortItems(books, { key: 'published', desc: false }))).toEqual(['Lyrics', 'Republic', 'Metamorphoses', 'Genji', 'Dune']);
    expect(titles(filterItems(books, 'originallyPublished:<-0400'))).toEqual(['Lyrics']);
    expect(titles(filterItems(books, 'originallyPublished:<1000'))).toEqual(['Metamorphoses', 'Lyrics', 'Republic']);
    expect(titles(filterItems(books, 'originallyPublished:>=1965-08'))).toEqual(['Dune']);
    expect(titles(filterItems(books, 'originallyPublished:"<500 BC"'))).toEqual(['Lyrics']);
  });

  it('sorts in either direction, with missing values last', () => {
    const titles = (items: { title: string }[]) => items.map((i) => i.title);
    expect(titles(sortItems([emma, dune], { key: 'title', desc: false }))).toEqual(['Dune', 'Emma']);
    expect(titles(sortItems([dune, emma], { key: 'title', desc: true }))).toEqual(['Emma', 'Dune']);
    // By surname: Austen, then Herbert.
    expect(titles(sortItems([dune, emma], { key: 'author', desc: false }))).toEqual(['Emma', 'Dune']);
    expect(titles(sortItems([dune, emma], { key: 'rating', desc: true }, { [emma.id]: 3 }))).toEqual(['Emma', 'Dune']);
    expect(titles(sortItems([dune, emma], { key: 'rating', desc: false }, { [emma.id]: 3 }))).toEqual(['Emma', 'Dune']);
  });

  it('sorts titles and authors by their sort fields, else by forms worked out from them', () => {
    const titles = (items: { title: string }[]) => items.map((i) => i.title);
    const hobbit = createItem({ title: 'The Hobbit', creators: [{ name: 'J. R. R. Tolkien', role: 'aut' }] });
    const ice = createItem({ title: 'Ice', creators: [{ name: 'Anna Kavan', role: 'aut' }] });
    const kafka = createItem({
      title: 'Amerika',
      creators: [{ name: 'Franz Kafka', role: 'aut' }],
      metadata: { titleSort: 'Man Who Disappeared, The', authorSort: 'Aardvark, Franz' },
    });
    // Hobbit, Ice, Man Who Disappeared.
    expect(titles(sortItems([kafka, ice, hobbit], { key: 'title', desc: false }))).toEqual(['The Hobbit', 'Ice', 'Amerika']);
    // Aardvark, Kavan, Tolkien.
    expect(titles(sortItems([hobbit, ice, kafka], { key: 'author', desc: false }))).toEqual(['Amerika', 'Ice', 'The Hobbit']);
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
      createItem({ title: 'B', metadata: { language: 'en', publisher: 'Y', titleSort: 'B', authorSort: 'Z' } }),
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
