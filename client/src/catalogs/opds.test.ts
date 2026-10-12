import { MemoryStorage, StoredLibraryBackend, type RemoteText } from '@nexlibris/common';
import { describe, expect, it } from 'vitest';
import { canSearch, CHECK_AFTER_MS, loadFeed, loadSearch, rememberPages, readCachedFeed } from './feedCache';
import { fillTemplate, parseOpdsFeed, parseOpenSearch } from './opdsFeed';
import type { TextFetcher } from './remote';

/** A static catalog as nexlibris (calibre3opds's layout) exports it: books on the first page, sections and search on the feed. */
const STATIC_ROOT = `<?xml version='1.0' encoding='utf-8'?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:dc="http://purl.org/dc/terms/">
<id>urn:calibre:root</id><title>Library</title>
<link rel="self" href="/index.xml" />
<link rel="search" href="/searchDescription.xml" type="application/opensearchdescription+xml" />
<link rel="search" href="/search/{searchTerms}/page-1.xml" type="application/atom+xml" />
<link rel="subsection" href="/navigation/index.xml" type="application/atom+xml" />
<link rel="first" href="/navigation/recent/page-1.xml" type="application/atom+xml" />
<link rel="last" href="/navigation/recent/page-6.xml" type="application/atom+xml" />
<link rel="next" href="/navigation/recent/page-2.xml" type="application/atom+xml" />
<entry><id>urn:calibre:book:1003</id><title>Lolly Willowes</title><author><name>Sylvia Townsend Warner</name></author>
<summary type="html">&lt;p&gt;Laura Willowes &amp;amp; her family.&lt;/p&gt;</summary>
<dc:identifier>urn:isbn:9780940322165</dc:identifier>
<link rel="relation" href="/navigation/tags/fantasy-fiction/page-1.xml" type="application/atom+xml;profile=opds-catalog;kind=navigation" title="Fantasy fiction" />
<link rel="http://opds-spec.org/acquisition" href="/books/lolly-willowes.pdf" type="application/pdf" />
<link rel="http://opds-spec.org/acquisition" href="/books/lolly-willowes.epub" type="application/epub+zip" />
<link rel="http://opds-spec.org/image" href="/covers/1003.jpg" type="image/jpeg" />
</entry>
</feed>`;

/** Project Gutenberg's: navigation entries to each book's own feed, search by an OpenSearch description. */
const GUTENBERG_LIST = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
<title>All Books</title>
<link rel="search" type="application/opensearchdescription+xml" href="https://www.gutenberg.org/catalog/osd-books.xml"/>
<link rel="self" type="application/atom+xml;profile=opds-catalog" href="/ebooks/search.opds/?sort_order=downloads"/>
<link rel="start" type="application/atom+xml;profile=opds-catalog" href="/ebooks.opds/"/>
<link rel="next" type="application/atom+xml;profile=opds-catalog" href="/ebooks/search.opds/?sort_order=downloads&amp;start_index=26"/>
<entry><id>https://www.gutenberg.org/ebooks/2701.opds</id><title>Moby Dick; Or, The Whale</title>
<content type="text">Herman Melville</content>
<link type="application/atom+xml;profile=opds-catalog" rel="subsection" href="/ebooks/2701.opds"/>
<link type="image/png" rel="http://opds-spec.org/image/thumbnail" href="data:image/png;base64,iVBORw0KGgo="/>
</entry>
</feed>`;

const OSD = `<?xml version="1.0" encoding="UTF-8"?>
<OpenSearchDescription xmlns="http://a9.com/-/spec/opensearch/1.1/">
<Url type="text/html" template="http://www.gutenberg.org/ebooks/search/?query={searchTerms}"/>
<Url type="application/atom+xml" template="http://m.gutenberg.org/ebooks/search.opds/?query={searchTerms}"/>
</OpenSearchDescription>`;

describe('reading OPDS catalogs', () => {
  it('reads a static catalog’s books, sections, next page and search', () => {
    const feed = parseOpdsFeed(STATIC_ROOT, 'https://library.example/index.xml');
    expect(feed.title).toBe('Library');
    expect(feed.next).toBe('https://library.example/navigation/recent/page-2.xml');
    expect(feed.sections).toEqual([{ href: 'https://library.example/navigation/index.xml', title: 'Browse' }]);
    expect(feed.search).toEqual({ description: 'https://library.example/searchDescription.xml', template: 'https://library.example/search/{searchTerms}/page-1.xml' });
    const [book] = feed.entries;
    expect(book).toMatchObject({
      kind: 'book',
      title: 'Lolly Willowes',
      authors: ['Sylvia Townsend Warner'],
      summary: '<p>Laura Willowes &amp; her family.</p>',
      cover: 'https://library.example/covers/1003.jpg',
      thumbnail: 'https://library.example/covers/1003.jpg',
      identifiers: ['urn:isbn:9780940322165'],
      related: [{ href: 'https://library.example/navigation/tags/fantasy-fiction/page-1.xml', title: 'Fantasy fiction' }],
    });
    // The EPUB first, though the server listed the PDF first.
    expect(book?.kind === 'book' && book.downloads.map((d) => d.format)).toEqual(['epub', 'pdf']);
  });

  it('reads Gutenberg’s lists as places to go, and its search from the description', () => {
    const feed = parseOpdsFeed(GUTENBERG_LIST, 'https://www.gutenberg.org/ebooks/search.opds/?sort_order=downloads');
    expect(feed.entries[0]).toMatchObject({ kind: 'navigation', title: 'Moby Dick; Or, The Whale', detail: 'Herman Melville', href: 'https://www.gutenberg.org/ebooks/2701.opds' });
    expect(feed.next).toBe('https://www.gutenberg.org/ebooks/search.opds/?sort_order=downloads&start_index=26');
    expect(feed.sections).toEqual([]);
    const template = parseOpenSearch(OSD, 'https://www.gutenberg.org/catalog/osd-books.xml');
    expect(template).toBe('http://m.gutenberg.org/ebooks/search.opds/?query={searchTerms}');
    expect(fillTemplate(template!, 'love & war')).toBe('http://m.gutenberg.org/ebooks/search.opds/?query=love%20%26%20war');
    expect(fillTemplate('https://x/s?q={searchTerms}&p={startPage?}', 'a')).toBe('https://x/s?q=a&p=');
  });

  it('refuses what isn’t a feed, and links that aren’t web addresses', () => {
    expect(() => parseOpdsFeed('<html/>', 'https://x/')).toThrow(/OPDS/);
    const feed = parseOpdsFeed(
      '<feed xmlns="http://www.w3.org/2005/Atom"><entry><title>X</title><link rel="http://opds-spec.org/acquisition" href="javascript:alert(1)" type="application/epub+zip"/></entry></feed>',
      'https://x/',
    );
    expect(feed.entries[0]).toMatchObject({ kind: 'book', downloads: [] });
  });
});

/** A server whose pages are `pages`, counting requests; conditional requests get 304 while the etag holds. */
function server(pages: Record<string, { text: string; etag?: string }>) {
  const calls: { url: string; headers?: Record<string, string> }[] = [];
  const fetcher: TextFetcher = async (url, headers) => {
    calls.push({ url, ...(headers && { headers }) });
    const page = pages[url];
    if (!page) return { status: 404, url, text: '' } satisfies RemoteText;
    if (page.etag && headers?.['If-None-Match'] === page.etag) return { status: 304, url, text: '' };
    return { status: 200, url, text: page.text, ...(page.etag && { etag: page.etag }) };
  };
  return { calls, fetcher };
}

const ROOT = 'https://library.example/index.xml';

describe('caching catalog pages', () => {
  it('reads a page once a day, then checks it, keeping it when unchanged', async () => {
    const backend = new StoredLibraryBackend(new MemoryStorage());
    const { calls, fetcher } = server({ [ROOT]: { text: STATIC_ROOT, etag: '"v1"' } });
    const start = new Date('2026-10-08T10:00:00Z');
    expect((await loadFeed(backend, ROOT, fetcher, { now: start })).cached.feed.title).toBe('Library');
    await loadFeed(backend, ROOT, fetcher, { now: new Date(start.getTime() + CHECK_AFTER_MS - 1) });
    expect(calls).toHaveLength(1);

    const later = new Date(start.getTime() + CHECK_AFTER_MS + 1);
    const { cached } = await loadFeed(backend, ROOT, fetcher, { now: later });
    expect(calls[1]).toEqual({ url: ROOT, headers: { 'If-None-Match': '"v1"' } });
    expect(cached).toMatchObject({ fetchedAt: start.toISOString(), checkedAt: later.toISOString() });
  });

  it('notices a change by the text, where the server gives nothing to check by', async () => {
    const backend = new StoredLibraryBackend(new MemoryStorage());
    const pages = { [ROOT]: { text: STATIC_ROOT } };
    const { fetcher } = server(pages);
    await loadFeed(backend, ROOT, fetcher);
    pages[ROOT] = { text: STATIC_ROOT.replace('<title>Library</title>', '<title>My Library</title>') };
    expect((await loadFeed(backend, ROOT, fetcher, { check: true })).cached.feed.title).toBe('My Library');
  });

  it('shows the cached page, marked, when the server can’t be reached', async () => {
    const backend = new StoredLibraryBackend(new MemoryStorage());
    await loadFeed(backend, ROOT, server({ [ROOT]: { text: STATIC_ROOT } }).fetcher);
    const down: TextFetcher = async () => {
      throw new Error('offline');
    };
    const loaded = await loadFeed(backend, ROOT, down, { check: true });
    expect(loaded).toMatchObject({ stale: 'offline', cached: { feed: { title: 'Library' } } });
    await expect(loadFeed(backend, 'https://elsewhere.example/', down)).rejects.toThrow('offline');
  });

  it('remembers how many pages were loaded', async () => {
    const backend = new StoredLibraryBackend(new MemoryStorage());
    await loadFeed(backend, ROOT, server({ [ROOT]: { text: STATIC_ROOT } }).fetcher);
    await rememberPages(backend, ROOT, 3);
    expect((await readCachedFeed(backend, ROOT))?.pages).toBe(3);
  });

  it('searches by the feed’s template; a static catalog with no page for the terms found nothing', async () => {
    const backend = new StoredLibraryBackend(new MemoryStorage());
    const results = 'https://library.example/search/willowes/page-1.xml';
    const { fetcher } = server({ [ROOT]: { text: STATIC_ROOT }, [results]: { text: STATIC_ROOT.replace('<title>Library</title>', '<title>Search: willowes</title>') } });
    expect(await canSearch(backend, ROOT)).toBe(false);
    expect((await loadSearch(backend, ROOT, 'willowes', fetcher)).cached.feed.title).toBe('Search: willowes');
    expect(await canSearch(backend, ROOT)).toBe(true);
    expect((await loadSearch(backend, ROOT, 'nothing here', fetcher)).cached.feed.entries).toEqual([]);
  });

  it('searches on the catalog’s own server when the description names one that doesn’t answer', async () => {
    const backend = new StoredLibraryBackend(new MemoryStorage());
    const root = 'https://www.gutenberg.org/ebooks.opds/';
    const own = 'https://www.gutenberg.org/ebooks/search.opds/?query=dune';
    const pages = {
      [root]: { text: GUTENBERG_LIST },
      'https://www.gutenberg.org/catalog/osd-books.xml': { text: OSD },
      [own]: { text: GUTENBERG_LIST.replace('All Books', 'Books: dune') },
    };
    const { fetcher, calls } = server(pages);
    const mirrorDown: TextFetcher = async (url, headers) => {
      if (url.includes('m.gutenberg.org')) throw new Error('504');
      return fetcher(url, headers);
    };
    expect((await loadSearch(backend, root, 'dune', mirrorDown)).cached.feed.title).toBe('Books: dune');
    // The mirror was asked over https (the catalog is), then the catalog's own server; next time, straight there.
    expect((await readCachedFeed(backend, root))?.searchTemplate).toBe('https://www.gutenberg.org/ebooks/search.opds/?query={searchTerms}');
    expect(calls.some((c) => c.url.startsWith('http://'))).toBe(false);
  });

  it('searches by a template set on the connection, without reading the description', async () => {
    const backend = new StoredLibraryBackend(new MemoryStorage());
    const root = 'https://www.gutenberg.org/ebooks.opds/';
    const own = 'https://www.gutenberg.org/ebooks/search.opds/?query=dune';
    const { fetcher, calls } = server({ [own]: { text: GUTENBERG_LIST.replace('All Books', 'Books: dune') } });
    const template = 'https://www.gutenberg.org/ebooks/search.opds/?query={searchTerms}';
    expect(await canSearch(backend, root, template)).toBe(true);
    expect((await loadSearch(backend, root, 'dune', fetcher, { template })).cached.feed.title).toBe('Books: dune');
    expect(calls.map((c) => c.url)).toEqual([own]);
  });

  it('says how to search a catalog whose description can’t be read', async () => {
    const backend = new StoredLibraryBackend(new MemoryStorage());
    const root = 'https://www.gutenberg.org/ebooks.opds/';
    const { fetcher } = server({ [root]: { text: GUTENBERG_LIST } });
    const blocked: TextFetcher = async (url, headers) => {
      if (url.includes('osd')) throw new TypeError('Failed to fetch');
      return fetcher(url, headers);
    };
    await expect(loadSearch(backend, root, 'dune', blocked)).rejects.toThrow(/search address in the connection’s settings/);
  });
});
