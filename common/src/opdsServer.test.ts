// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { parseXml } from '@nexlibris/tools/formats/xml';
import { applyOperations, createDevice, createItem, createLibrary } from './operations';
import { OPDS_SERVED_TYPE, serveOpds, type OpdsRequest, type OpdsResponse } from './opdsServer';
import type { Device, Item, Library } from './types';

const hash = (n: number) => n.toString(16).padStart(64, '0');

const item = (title: string, author: string, extra: Partial<Item> = {}, n = 1): Item => ({
  ...createItem({ title, creators: [{ name: author, role: 'aut' }], ...extra }, '2026-01-01T00:00:00.000Z'),
  addedAt: `2026-01-0${n}T00:00:00.000Z`,
  files: [
    { hash: hash(n), size: 10, format: 'epub' },
    { hash: hash(n + 100), size: 20, format: 'pdf' },
  ],
});

const dune = item('Dune', 'Frank Herbert', { tags: ['Sci-fi'], metadata: { series: 'Dune', seriesIndex: 1 } }, 1);
const messiah = item('Dune Messiah', 'Frank Herbert', { tags: ['Sci-fi'], metadata: { series: 'Dune', seriesIndex: 2 } }, 2);
const emma = item('Emma', 'Jane Austen', { tags: ['Classics'], cover: { hash: hash(9), mediaType: 'image/png' } }, 3);
const hidden = item('Hidden', 'Nobody', {}, 4);

function libraryWith(device: Device): Library {
  return applyOperations(createLibrary('Home'), [
    ...[dune, messiah, emma, hidden].map((i) => ({ type: 'addItem' as const, item: i })),
    { type: 'addDevice', device },
    { type: 'setCategory', category: { id: 'moods', name: 'Moods', entries: [{ label: 'Old', query: 'austen' }, { label: 'Sandy', query: 'dune' }] } },
  ]).library;
}

const shelf = { ...createDevice({ name: 'Shelf', type: OPDS_SERVED_TYPE, settings: { formats: 'epub' } }), items: [dune.id, messiah.id, emma.id] };
const library = libraryWith(shelf);

const ask = (path: string, query = '', accept?: string): OpdsResponse =>
  serveOpds(library, { path, query: new URLSearchParams(query), root: '/opds', ...(accept && { accept }), now: '2026-10-01T00:00:00Z' } satisfies OpdsRequest);

function body(response: OpdsResponse): string {
  if (!('body' in response)) throw new Error(`No feed: ${JSON.stringify(response)}`);
  return response.body;
}
const xml = (response: OpdsResponse) => parseXml(body(response))!;
const titles = (doc: Document) => [...doc.getElementsByTagName('entry')].map((e) => e.getElementsByTagName('title')[0]!.textContent);
const links = (doc: Document, rel: string) =>
  [...doc.getElementsByTagName('link')].filter((l) => l.getAttribute('rel') === rel).map((l) => l.getAttribute('href'));
const json = (response: OpdsResponse) => JSON.parse(body(response));
const at = `/opds/${shelf.id}`;

describe('OPDS feeds served live', () => {
  it('lists the library’s served feeds at the root, in either format', () => {
    const other = { ...createDevice({ name: 'Reader', type: 'crosspoint.reader' }) };
    const both = applyOperations(library, [{ type: 'addDevice', device: other }]).library;
    const root = serveOpds(both, { path: '', query: new URLSearchParams(), root: '/opds' });
    expect(titles(parseXml(body(root))!)).toEqual(['Shelf']);
    expect(json(ask('index.json')).navigation).toEqual([
      { href: `${at}/index.json`, title: 'Shelf', type: 'application/opds+json', rel: 'subsection' },
    ]);
  });

  it('browses a catalog as the Library does, with the user’s categories', () => {
    const index = ask(`${shelf.id}/index.xml`);
    expect(index).toMatchObject({ contentType: 'application/atom+xml;profile=opds-catalog;kind=navigation' });
    expect(titles(xml(index))).toEqual(['Recent books', 'By title', 'Authors', 'Series', 'Moods', 'Tags']);
    expect(links(xml(index), 'search')).toEqual([`${at}/opensearch.xml`, `${at}/search.xml?q={searchTerms}`]);

    // Only its catalog's books, by title, in the formats it offers.
    const byTitle = xml(ask(`${shelf.id}/titles.xml`));
    expect(titles(byTitle)).toEqual(['Dune', 'Dune Messiah', 'Emma']);
    expect(links(byTitle, 'http://opds-spec.org/acquisition')).toEqual([
      `${at}/files/${hash(1)}/Dune%20-%20Frank%20Herbert.epub`,
      `${at}/files/${hash(2)}/Dune%20Messiah%20-%20Frank%20Herbert.epub`,
      `${at}/files/${hash(3)}/Emma%20-%20Jane%20Austen.epub`,
    ]);
    expect(links(byTitle, 'http://opds-spec.org/image')).toEqual([`${at}/covers/${emma.id}`]);
    expect(titles(xml(ask(`${shelf.id}/recent.xml`)))).toEqual(['Emma', 'Dune Messiah', 'Dune']);

    expect(titles(xml(ask(`${shelf.id}/series.xml`)))).toEqual(['Dune']);
    expect(titles(xml(ask(`${shelf.id}/series/dune.xml`)))).toEqual(['Dune', 'Dune Messiah']);
    expect(titles(xml(ask(`${shelf.id}/authors/jane-austen.xml`)))).toEqual(['Emma']);
    expect(titles(xml(ask(`${shelf.id}/categories/moods.xml`)))).toEqual(['Old', 'Sandy']);
    expect(titles(xml(ask(`${shelf.id}/categories/moods/sandy.xml`)))).toEqual(['Dune', 'Dune Messiah']);
  });

  it('writes OPDS 2 JSON by extension or by what the reader accepts', () => {
    const feed = json(ask(`${shelf.id}/tags/sci-fi.json`));
    expect(feed.metadata).toMatchObject({ title: 'Sci-fi', numberOfItems: 2, currentPage: 1 });
    expect(feed.links).toContainEqual({ rel: 'search', href: `${at}/search.json{?query}`, type: 'application/opds+json', templated: true });
    expect(feed.publications[1].metadata).toMatchObject({
      title: 'Dune Messiah',
      author: [{ name: 'Frank Herbert' }],
      belongsTo: { series: [{ name: 'Dune', position: 2 }] },
      subject: [{ name: 'Sci-fi', links: [{ href: `${at}/tags/sci-fi.json`, type: 'application/opds+json' }] }],
    });
    expect(feed.publications[1].links).toEqual([
      { rel: 'http://opds-spec.org/acquisition', href: `${at}/files/${hash(2)}/Dune%20Messiah%20-%20Frank%20Herbert.epub`, type: 'application/epub+zip' },
    ]);

    const negotiated = ask(`${shelf.id}/`, '', 'application/opds+json, application/atom+xml;q=0.5');
    expect(negotiated).toMatchObject({ contentType: 'application/opds+json' });
    expect(json(negotiated).navigation.map((n: { title: string }) => n.title)).toContain('Authors');
    expect(ask(`${shelf.id}/`, '', 'application/atom+xml')).toMatchObject({ contentType: expect.stringContaining('atom+xml') });
  });

  it('searches with the library’s search syntax, within the catalog', () => {
    expect(titles(xml(ask(`${shelf.id}/search.xml`, 'q=messiah')))).toEqual(['Dune Messiah']);
    expect(json(ask(`${shelf.id}/search.json`, 'query=author:herbert -tag:classics')).publications.map((p: { metadata: { title: string } }) => p.metadata.title)).toEqual([
      'Dune',
      'Dune Messiah',
    ]);
    expect(titles(xml(ask(`${shelf.id}/search.xml`, 'q=hidden')))).toEqual([]);
    expect(ask(`${shelf.id}/search.xml`)).toMatchObject({ status: 400 });
    expect(body(ask(`${shelf.id}/opensearch.xml`))).toContain(`template="${at}/search.xml?q={searchTerms}"`);
  });

  it('paginates with ?page=', () => {
    const many = { ...shelf, id: 'many', settings: {}, items: [], query: 'has:file' };
    const lib = applyOperations(createLibrary('Big'), [
      ...Array.from({ length: 30 }, (_, i) => ({ type: 'addItem' as const, item: item(`Book ${String(i).padStart(2, '0')}`, 'Anon', {}, i + 1) })),
      { type: 'addDevice', device: many },
    ]).library;
    const page = (n: string) => serveOpds(lib, { path: 'many/titles.xml', query: new URLSearchParams(n), root: '/opds' });
    const first = parseXml(body(page('')))!;
    expect(titles(first)).toHaveLength(25);
    expect(links(first, 'next')).toEqual(['/opds/many/titles.xml?page=2']);
    const second = parseXml(body(page('page=2')))!;
    expect(titles(second)).toHaveLength(5);
    expect(links(second, 'previous')).toEqual(['/opds/many/titles.xml']);
    expect(page('page=3')).toMatchObject({ status: 404 });
    // No formats picked: every file of each book.
    expect(links(first, 'http://opds-spec.org/acquisition')).toHaveLength(50);
  });

  it('gives the files of the catalog’s books, and nothing else', () => {
    expect(ask(`${shelf.id}/files/${hash(1)}/Dune.epub`)).toEqual({
      status: 200,
      file: { hash: hash(1), mediaType: 'application/epub+zip', name: 'Dune - Frank Herbert.epub' },
    });
    // A format it doesn't offer, a book not in it, another library's connection.
    expect(ask(`${shelf.id}/files/${hash(101)}/Dune.pdf`)).toMatchObject({ status: 404 });
    expect(ask(`${shelf.id}/files/${hash(4)}/x`)).toMatchObject({ status: 404 });
    expect(ask(`${shelf.id}/covers/${emma.id}`)).toEqual({ status: 200, file: { hash: hash(9), mediaType: 'image/png' } });
    expect(ask(`${shelf.id}/covers/${dune.id}`)).toMatchObject({ status: 404 });
    expect(ask('elsewhere/index.xml')).toMatchObject({ status: 404 });
    expect(ask(`${shelf.id}/authors/nobody.xml`)).toMatchObject({ status: 404 });
  });
});
