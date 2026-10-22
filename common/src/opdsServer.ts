import { deviceItemFiles, deviceItems } from './catalog';
import {
  arrangeFeeds,
  atomFeed,
  bookPage,
  feedBook,
  feedCategories,
  navigationPage,
  OPDS_ACQUISITION,
  OPDS_JSON,
  OPDS_NAVIGATION,
  openSearchDescription,
  OPENSEARCH_DESCRIPTION,
  opds2Feed,
  slug,
  authorsOf,
  type ArrangedFeeds,
  type FeedBook,
  type FeedGroup,
  type OpdsNavigationEntry,
  type OpdsPage,
  type OpdsPublication,
} from './opds';
import { userData } from './operations';
import { filterItems } from './search';
import type { Device, FileHash, Library } from './types';

/**
 * OPDS feeds served live, from the library as it is at each request (`opds.ts` writes them): each
 * of the library's served feed connections (`opds.served`, the client's `opdsServed`) is served at
 * `<root>/<connection id>/`, its books those of its catalog, each in every format it offers, and
 * searched with the library's own search syntax. `<root>/` lists them. Every feed is either OPDS 1.2 (Atom XML) or
 * OPDS 2.0 (JSON): by its extension, `.xml` or `.json`, else by what the request accepts. Within a
 * catalog:
 *
 * - `index` the navigation: `recent` and `titles` (books), `authors`, `series`, `tags` (lists of
 *   them, each with a feed at `authors/<slug>` and so on), and the user's categories at
 *   `categories/<slug>` (a category with one entry is its books, others list theirs, at
 *   `categories/<slug>/<slug>`);
 * - `search?q=<query>` (OPDS 2's template uses `query`), and `opensearch.xml` describing it;
 * - `files/<hash>/<name>` a book's file and `covers/<item id>` its cover, which the caller serves
 *   (`OpdsFile`), each only if it's a book of the catalog.
 *
 * Pages of books are `?page=N`, from 1. The caller authenticates; this only reads the library.
 */

/** The connection type served (the client's `opdsServed`). */
export const OPDS_SERVED_TYPE = 'opds.served';

const PAGE_SIZE = 25;

export type OpdsFormat = 'xml' | 'json';

export interface OpdsRequest {
  /** The path below the root, without a leading slash, e.g. `<id>/authors/jane-austen.json`. */
  path: string;
  query: URLSearchParams;
  /** The request's `Accept` header, for paths without an extension. */
  accept?: string;
  /** Where the catalogs are served, as links give it, e.g. `/opds`. */
  root: string;
  now?: string;
}

/** A book's file or cover to send, which the server reads from its store. */
export interface OpdsFile {
  hash: FileHash;
  mediaType: string;
  /** A name to save it under (books only). */
  name?: string;
}

export type OpdsResponse =
  | { status: 200; contentType: string; body: string }
  | { status: 200; file: OpdsFile }
  | { status: 404 | 400; message: string };

const notFound = { status: 404, message: 'There’s no such catalog page.' } as const;

/** The library's feeds served live. */
export const servedFeeds = (library: Library) => Object.values(library.devices ?? {}).filter((device) => device.type === OPDS_SERVED_TYPE);

/** The formats a served feed offers (its Formats setting, `SERVED_FORMATS`), or none for every one a book has. */
export function servedFormats(device: Device): string[] {
  const picked = device.settings.formats;
  return typeof picked === 'string'
    ? picked
        .split(',')
        .map((v) => v.trim())
        .filter(Boolean)
    : [];
}

/** A served feed's books: each item of its catalog with its files in the formats it offers, items with none left out. */
export function servedBooks(library: Library, device: Device): FeedBook[] {
  const formats = servedFormats(device);
  return deviceItems(library, device).flatMap((item) => {
    const files = deviceItemFiles(item, device, formats, true);
    return files.length ? [feedBook(item, files)] : [];
  });
}

function formatOf(path: string, accept = ''): { format: OpdsFormat; route: string } {
  const extension = /\.(xml|json)$/.exec(path)?.[1] as OpdsFormat | undefined;
  if (extension) return { format: extension, route: path.slice(0, -extension.length - 1) };
  return { format: /application\/(opds\+)?json/.test(accept) ? 'json' : 'xml', route: path.replace(/\/$/, '') };
}

const reply = (page: OpdsPage, format: OpdsFormat): OpdsResponse =>
  format === 'json'
    ? { status: 200, contentType: OPDS_JSON, body: JSON.stringify(opds2Feed(page)) }
    : { status: 200, contentType: page.kind === 'navigation' ? OPDS_NAVIGATION : OPDS_ACQUISITION, body: atomFeed(page) };

/** Answers a request for a catalog's page or file. */
export function serveOpds(library: Library, request: OpdsRequest): OpdsResponse {
  const now = request.now ?? lastChanged(library);
  const root = request.root.replace(/\/$/, '');
  const [first = '', ...rest] = request.path.split('/');
  const { format, route: listRoute } = formatOf(request.path, request.accept);

  // The root: the catalogs there are.
  if (!rest.length && (listRoute === '' || listRoute === 'index')) {
    const ext = `.${format}`;
    const self = `${root}/index${ext}`;
    return reply(
      navigationPage(
        { id: 'urn:nexlibris:catalogs', title: library.name, updated: now, self, start: self },
        servedFeeds(library).map((device) => ({ title: device.name, href: `${root}/${encodeURIComponent(device.id)}/index${ext}`, kind: 'navigation' })),
      ),
      format,
    );
  }

  let id: string;
  try {
    id = decodeURIComponent(first);
  } catch {
    return notFound;
  }
  const device = library.devices?.[id];
  if (device?.type !== OPDS_SERVED_TYPE) return notFound;
  return serveCatalog(library, device, rest.join('/'), request, `${root}/${encodeURIComponent(device.id)}`, now);
}

function serveCatalog(library: Library, device: Device, path: string, request: OpdsRequest, base: string, now: string): OpdsResponse {
  const books = servedBooks(library, device);

  const file = /^files\/([0-9a-f]{64})(?:\/[^/]*)?$/.exec(path);
  if (file) {
    for (const book of books) {
      const offered = book.formats.find((f) => f.hash === file[1]);
      if (offered) return { status: 200, file: { hash: offered.hash!, mediaType: offered.mediaType, name: fileName(book, offered.format) } };
    }
    return notFound;
  }
  const cover = /^covers\/([^/]+)$/.exec(path);
  if (cover) {
    const book = books.find((b) => b.item.id === cover[1]);
    return book?.cover ? { status: 200, file: { hash: book.cover.hash, mediaType: book.cover.mediaType } } : notFound;
  }
  if (path === 'opensearch.xml') {
    return { status: 200, contentType: OPENSEARCH_DESCRIPTION, body: openSearchDescription(device.name, `${base}/search.xml?q={searchTerms}`) };
  }

  const { format, route } = formatOf(path, request.accept);
  const ext = `.${format}`;
  const page = Math.max(1, Math.floor(Number(request.query.get('page'))) || 1) - 1;
  const href = (to: string) => `${base}/${to}${ext}`;
  const pageHref = (to: string, query = '') => (n: number) => {
    const params = new URLSearchParams(query);
    if (n > 0) params.set('page', String(n + 1));
    return `${href(to)}${params.size ? `?${params}` : ''}`;
  };
  const pageBase = (id: string, title: string) => ({
    id: `urn:nexlibris:${device.id}:${id}`,
    title,
    updated: now,
    start: href('index'),
    search: format === 'json' ? { template: `${base}/search.json{?query}` } : { description: `${base}/opensearch.xml`, template: `${base}/search.xml?q={searchTerms}` },
  });
  const publication = (book: FeedBook): OpdsPublication => ({
    book,
    acquisitions: book.formats.map(({ format: f, mediaType, hash }) => ({ href: `${base}/files/${hash}/${encodeURIComponent(fileName(book, f))}`, type: mediaType })),
    ...(book.cover && { cover: { href: `${base}/covers/${encodeURIComponent(book.item.id)}`, type: book.cover.mediaType } }),
    tagHref: (tag) => href(`tags/${slug(tag)}`),
  });
  const list = (to: string, title: string, items: FeedBook[], query = '') =>
    page * PAGE_SIZE >= Math.max(items.length, 1)
      ? notFound
      : reply(bookPage(pageBase(`${to}:${page + 1}`, title), items, page, PAGE_SIZE, pageHref(to, query), publication), format);
  const places = (to: string, title: string, entries: OpdsNavigationEntry[]) =>
    reply(navigationPage({ ...pageBase(to, title), self: href(to) }, entries), format);
  const groups = (kind: string, all: FeedGroup[]): OpdsNavigationEntry[] =>
    all.map((g) => ({ title: g.label, href: href(`${kind}/${g.key}`), kind: 'acquisition', count: g.books.length }));

  if (route === 'search') {
    const terms = (request.query.get('q') ?? request.query.get('query') ?? '').trim();
    if (!terms) return { status: 400, message: 'Say what to search for.' };
    const found = new Set(filterItems(books.map((b) => b.item), terms, { ratings: userData(library).ratings }).map((item) => item.id));
    return list('search', `Search: ${terms}`, books.filter((b) => found.has(b.item.id)), new URLSearchParams({ q: terms }).toString());
  }

  const catalog: ArrangedFeeds = arrangeFeeds(books, feedCategories(library, books.map((b) => b.item)));
  const custom = (key: string) => catalog.categories.find((c) => c.key === key);
  const [section = '', key, entryKey, ...more] = route.split('/');
  if (more.length) return notFound;

  if (route === '' || route === 'index') {
    return places('index', device.name, [
      { title: 'Recent books', href: href('recent'), kind: 'acquisition', count: books.length },
      { title: 'By title', href: href('titles'), kind: 'acquisition', count: books.length },
      { title: 'Authors', href: href('authors'), kind: 'navigation', count: catalog.authors.length },
      { title: 'Series', href: href('series'), kind: 'navigation', count: catalog.series.length },
      ...catalog.categories.map(
        (c): OpdsNavigationEntry =>
          c.entries.length === 1
            ? { title: c.name, href: href(`categories/${c.key}`), kind: 'acquisition', count: c.entries[0]!.books.length }
            : { title: c.name, href: href(`categories/${c.key}`), kind: 'navigation', count: c.entries.length },
      ),
      { title: 'Tags', href: href('tags'), kind: 'navigation', count: catalog.tags.length },
    ]);
  }
  if (route === 'recent') return list('recent', 'Recent books', catalog.recent);
  if (route === 'titles') return list('titles', 'Books by title', catalog.books);
  if (section === 'authors' || section === 'series' || section === 'tags') {
    const title = { authors: 'Authors', series: 'Series', tags: 'Tags' }[section];
    if (key === undefined) return places(section, title, groups(section, catalog[section]));
    const group = catalog[section].find((g) => g.key === key);
    return group && entryKey === undefined ? list(`${section}/${key}`, group.label, group.books) : notFound;
  }
  if (section === 'categories' && key !== undefined) {
    const category = custom(key);
    if (!category) return notFound;
    if (entryKey === undefined) {
      if (category.entries.length === 1) return list(`categories/${key}`, category.name, category.entries[0]!.books);
      return places(`categories/${key}`, category.name, groups(`categories/${key}`, category.entries));
    }
    const entry = category.entries.length > 1 ? category.entries.find((e) => e.key === entryKey) : undefined;
    return entry ? list(`categories/${key}/${entryKey}`, entry.label, entry.books) : notFound;
  }
  return notFound;
}

/** When the library's books or connections last changed, as feeds' `updated`, so a feed reads the same until they do. */
function lastChanged(library: Library): string {
  let latest = '1970-01-01T00:00:00.000Z';
  for (const item of Object.values(library.items)) if (item.updatedAt > latest) latest = item.updatedAt;
  for (const device of Object.values(library.devices ?? {})) if (device.addedAt > latest) latest = device.addedAt;
  return latest;
}

/** What a book's file is saved as: `<title> - <authors>.<format>`, kept to safe characters. */
function fileName({ item }: FeedBook, format: string): string {
  const name = [item.title, authorsOf(item).join(', ')].filter(Boolean).join(' - ');
  return `${name.replace(/[\\/:*?"<>|\p{Cc}]+/gu, '_').slice(0, 120).trim() || 'book'}.${format}`;
}
