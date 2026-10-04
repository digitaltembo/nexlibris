import {
  createDevice,
  createItem,
  MemoryStorage,
  StoredLibraryBackend,
  type FileRef,
  type Item,
} from '@nexlibris/common';
import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import type { Converter } from '../../formats/convert/converters';
import { parseXml } from '../../formats/xml';
import type { CatalogType } from '../types';
import { buildCatalog, slug, type CatalogBook, type CatalogFile } from './catalog';
import { exportCatalog, MANIFEST_PATH, type CatalogSink } from './export';
import { zipSink } from './sinks';

const book = (title: string, authors: string[], extra: Partial<Item> = {}, addedAt = '2026-01-01T00:00:00Z'): CatalogBook => ({
  item: { ...createItem({ title, creators: authors.map((name) => ({ name, role: 'aut' })), ...extra }), addedAt },
  formats: [
    { format: 'x4.epub', mediaType: 'application/epub+zip' },
    { format: 'epub', mediaType: 'application/epub+zip' },
  ],
});

const feeds = (files: CatalogFile[]) =>
  new Map(files.flatMap((f) => ('text' in f ? [[f.path, f.text] as const] : [])));
const xml = (text: string) => parseXml(text)!;
const links = (doc: Document, rel: string) =>
  Array.from(doc.getElementsByTagName('link'))
    .filter((l) => l.getAttribute('rel') === rel)
    .map((l) => l.getAttribute('href'));
const titles = (doc: Document) =>
  Array.from(doc.getElementsByTagName('entry')).map((e) => e.getElementsByTagName('title')[0]!.textContent);

describe('OPDS catalog', () => {
  it('slugs like calibre3opds', () => {
    expect(slug('Émile Zola: Œuvres!')).toBe('emile-zola-uvres');
    expect(slug('  ')).toBe('untitled');
  });

  it('writes the calibre3opds layout, with every format and cover linked', () => {
    const dune = book('Dune', ['Frank Herbert'], { tags: ['Sci-fi'], metadata: { series: 'Dune', seriesIndex: 1 } });
    dune.cover = { hash: 'c0ffee', mediaType: 'image/png' };
    const emma = book('Emma & <Friends>', ['Jane Austen'], { tags: ['Classics', 'sci-fi'] }, '2026-02-01T00:00:00Z');
    const files = buildCatalog([dune, emma], { title: 'My X4', now: '2026-10-01T00:00:00Z' });
    const byPath = feeds(files);

    expect([...byPath.keys()].sort()).toEqual(
      [
        'index.xml',
        'navigation/index.xml',
        'navigation/titles/page-1.xml',
        'navigation/recent/page-1.xml',
        'navigation/authors/index.xml',
        'navigation/authors/frank-herbert/page-1.xml',
        'navigation/authors/jane-austen/page-1.xml',
        'navigation/series/index.xml',
        'navigation/series/dune/page-1.xml',
        'navigation/tags/index.xml',
        'navigation/tags/sci-fi/page-1.xml',
        'navigation/tags/classics/page-1.xml',
        'search.xml',
        'searchDescription.xml',
        ...['dune', 'emma-friends', 'frank-herbert', 'jane-austen', 'sci-fi', 'classics'].map((t) => `search/${t}/page-1.xml`),
      ].sort(),
    );
    // Every feed parses, escaping included.
    for (const [path, text] of byPath) expect(parseXml(text), path).toBeTruthy();

    const root = xml(byPath.get('index.xml')!);
    expect(titles(root)).toEqual(['Emma & <Friends>', 'Dune']);
    expect(links(root, 'search')).toEqual(['/searchDescription.xml', '/search/{searchTerms}/page-1.xml']);
    expect(links(root, 'http://opds-spec.org/acquisition')).toEqual([
      '/books/emma-friends_jane-austen.x4.epub',
      '/books/emma-friends_jane-austen.epub',
      '/books/dune_frank-herbert.x4.epub',
      '/books/dune_frank-herbert.epub',
    ]);
    expect(links(root, 'http://opds-spec.org/image')).toEqual([`/covers/${dune.item.id}.png`]);

    // Tags that differ only in case share a feed.
    expect(titles(xml(byPath.get('navigation/tags/sci-fi/page-1.xml')!))).toEqual(['Dune', 'Emma & <Friends>']);
    expect(titles(xml(byPath.get('navigation/tags/index.xml')!))).toEqual(['Classics', 'Sci-fi']);

    expect(files.filter((f) => !('text' in f))).toEqual([
      { path: 'books/dune_frank-herbert.x4.epub', book: { itemId: dune.item.id, format: 'x4.epub' } },
      { path: 'books/dune_frank-herbert.epub', book: { itemId: dune.item.id, format: 'epub' } },
      { path: `covers/${dune.item.id}.png`, cover: 'c0ffee' },
      { path: 'books/emma-friends_jane-austen.x4.epub', book: { itemId: emma.item.id, format: 'x4.epub' } },
      { path: 'books/emma-friends_jane-austen.epub', book: { itemId: emma.item.id, format: 'epub' } },
    ]);
  });

  it('lists the user’s categories between Series and Tags, as calibre3opds’s custom feeds', () => {
    const dune = book('Dune', ['Frank Herbert']);
    const emma = book('Emma', ['Jane Austen']);
    const files = buildCatalog([dune, emma], {
      title: 'Lib',
      categories: [
        { name: 'Moods', entries: [{ label: 'Sandy', itemIds: [dune.item.id] }, { label: 'Witty', itemIds: [emma.item.id, 'gone'] }] },
        { name: 'Classics', entries: [{ label: 'Old', itemIds: [emma.item.id] }] },
        { name: 'Empty', entries: [] },
      ],
    });
    const byPath = feeds(files);
    const root = xml(byPath.get('navigation/index.xml')!);
    expect(titles(root)).toEqual(['Recent books', 'By title', 'Authors', 'Series', 'Classics', 'Moods', 'Tags']);
    // One entry links straight to its books; several open a list of them.
    expect(links(root, 'subsection')).toContain('/navigation/custom/classics/page-1.xml');
    expect(titles(xml(byPath.get('navigation/custom/classics/page-1.xml')!))).toEqual(['Emma']);
    const moods = xml(byPath.get('navigation/custom/moods/index.xml')!);
    expect(titles(moods)).toEqual(['Sandy', 'Witty']);
    expect(links(moods, 'subsection')).toEqual(['/navigation/custom/moods/sandy/page-1.xml', '/navigation/custom/moods/witty/page-1.xml']);
    expect(titles(xml(byPath.get('navigation/custom/moods/witty/page-1.xml')!))).toEqual(['Emma']);
  });

  it('paginates, and names books apart when their stems clash', () => {
    const books = Array.from({ length: 5 }, (_, i) => book('Same', ['Anon'], {}, `2026-01-0${i + 1}T00:00:00Z`));
    const files = buildCatalog(books, { title: 'Lib', pageSize: 2 });
    const byPath = feeds(files);
    expect([...byPath.keys()].filter((p) => p.startsWith('navigation/titles/'))).toEqual([
      'navigation/titles/page-1.xml',
      'navigation/titles/page-2.xml',
      'navigation/titles/page-3.xml',
    ]);
    const middle = xml(byPath.get('navigation/titles/page-2.xml')!);
    expect(links(middle, 'previous')).toEqual(['/navigation/titles/page-1.xml']);
    expect(links(middle, 'next')).toEqual(['/navigation/titles/page-3.xml']);
    expect(links(middle, 'last')).toEqual(['/navigation/titles/page-3.xml']);
    expect(links(xml(byPath.get('index.xml')!), 'next')).toEqual(['/navigation/recent/page-2.xml']);
    const stems = files.flatMap((f) => ('book' in f && f.book.format === 'epub' ? [f.path] : []));
    expect(stems).toEqual(['books/same_anon.epub', 'books/same_anon-2.epub', 'books/same_anon-3.epub', 'books/same_anon-4.epub', 'books/same_anon-5.epub']);
  });
});

/** A folder as a map, keeping a manifest like `directorySink`. */
function memorySink() {
  const files = new Map<string, string>();
  const sink: CatalogSink = {
    async readManifest() {
      const text = files.get(MANIFEST_PATH);
      return text ? JSON.parse(text) : undefined;
    },
    async write(path, data) {
      files.set(path, typeof data === 'string' ? data : await data.text());
    },
    async remove(path) {
      files.delete(path);
    },
  };
  return { files, sink };
}

const optimizer: Converter = {
  id: 'test-x4',
  from: ['epub'],
  to: 'x4.epub',
  version: '1',
  run: async (data) => new Blob([`${await data.text()} for x4`]),
};

const type: CatalogType = {
  kind: 'catalog',
  id: 'test.catalog',
  label: 'Catalog',
  formats: ['x4.epub', 'epub'],
  settings: [],
  makes: () => optimizer,
  prepare: { key: (item) => item.title, run: async (item, _f, data) => new Blob([`${await data.text()} titled ${item.title}`]) },
};

async function setup() {
  const backend = new StoredLibraryBackend(new MemoryStorage());
  const add = async (title: string, files: Record<string, string>) => {
    const refs: FileRef[] = [];
    for (const [format, text] of Object.entries(files)) {
      const { hash, size } = await backend.putFile(new Blob([text]));
      refs.push({ hash, size, format });
    }
    const item = createItem({ title, creators: [{ name: 'Author', role: 'aut' }], files: refs });
    await backend.apply([{ type: 'addItem', item }]);
    return item;
  };
  const dune = await add('Dune', { epub: 'dune' });
  const notes = await add('Notes', { txt: 'notes' });
  const device = createDevice({ name: 'X4', type: type.id });
  await backend.apply([{ type: 'addDevice', device }, { type: 'addDeviceItems', id: device.id, itemIds: [dune.id, notes.id] }]);
  const run = async (sink: CatalogSink) => {
    const library = await backend.getLibrary();
    const result = await exportCatalog(library, library.devices![device.id]!, type, backend, sink);
    await backend.apply(result.operations);
    return result;
  };
  return { backend, dune, run };
}

describe('catalog export', () => {
  it('makes and keeps the device format, writes metadata in, and copies only what changed', async () => {
    const { backend, dune, run } = await setup();
    const { files, sink } = memorySink();
    const first = await run(sink);
    expect(first).toMatchObject({ books: 1, written: 2, unchanged: 0, skipped: ['Notes'], warnings: [] });
    expect(files.get('books/dune_author.x4.epub')).toBe('dune for x4 titled Dune');
    expect(files.get('books/dune_author.epub')).toBe('dune titled Dune');
    const stored = (await backend.getLibrary()).items[dune.id]!.files;
    expect(stored.map((f) => f.format)).toEqual(['epub', 'x4.epub']);
    // Each book file, for recording what the connection holds (covers and feeds aren't books).
    expect(first.placed).toEqual({
      'books/dune_author.x4.epub': { itemId: dune.id, hash: stored[1]!.hash, size: 23, key: 'Dune' },
      'books/dune_author.epub': { itemId: dune.id, hash: stored[0]!.hash, size: 16, key: 'Dune' },
    });

    const second = await run(sink);
    expect(second).toMatchObject({ written: 0, unchanged: 2, removed: 0, operations: [] });
    expect(Object.keys(second.placed).sort()).toEqual(Object.keys(first.placed).sort());

    await backend.apply([{ type: 'updateItem', id: dune.id, patch: { title: 'Dune Messiah' } }]);
    const third = await run(sink);
    expect(third).toMatchObject({ written: 2, unchanged: 0 });
    expect(files.has('books/dune_author.epub')).toBe(false);
    expect(files.has('search/dune/page-1.xml')).toBe(false);
    expect(files.has('search/dune-messiah/page-1.xml')).toBe(true);
    expect(files.get('books/dune-messiah_author.epub')).toBe('dune titled Dune Messiah');
  });

  it('saves a zip of the whole catalog', async () => {
    const { run } = await setup();
    let saved: Blob | undefined;
    const sink = zipSink('X4 catalog.zip', async (zip) => {
      saved = zip;
      return true;
    });
    await run(sink);
    expect(sink.saved).toBe(true);
    const zip = await JSZip.loadAsync(await saved!.arrayBuffer());
    expect(Object.keys(zip.files)).toContain('index.xml');
    expect(await zip.file('books/dune_author.x4.epub')!.async('string')).toBe('dune for x4 titled Dune');
  });
});
