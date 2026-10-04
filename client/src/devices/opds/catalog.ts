import type { FileHash, Item, ItemId } from '@nexlibris/common';

/**
 * A static OPDS 1.2 catalog, in the shape calibre3opds (`~/dev/calibre3opds`)
 * writes, so the same hosting (and CrossPoint's OPDS browser) works for both:
 *
 * - `index.xml`: the root, with the most recent books and a link to navigation;
 * - `navigation/index.xml`, and paginated `navigation/{recent,titles}/page-N.xml`;
 * - `navigation/{authors,tags,series}/index.xml`, each with a paginated feed per entry;
 * - `search/<term>/page-N.xml` for every title, author, tag and series term (a static host
 *   can't run a query), listed in `search.xml` and advertised by `searchDescription.xml`;
 * - `books/<stem>.<format>` and `covers/<id>.<ext>`.
 *
 * Links are absolute (`/…`), so the catalog is meant to be served from the root of a host.
 */

const ATOM = 'http://www.w3.org/2005/Atom';
const OPDS = 'http://opds-spec.org/2010/catalog';
const DC = 'http://purl.org/dc/terms/';
const OPENSEARCH = 'http://a9.com/-/spec/opensearch/1.1/';
const CALIBRE = 'http://calibre-ebook.com';
const NAVIGATION = 'application/atom+xml;profile=opds-catalog;kind=navigation';
const ACQUISITION = 'application/atom+xml;profile=opds-catalog;kind=acquisition';
export const SEARCH_TEMPLATE = '/search/{searchTerms}/page-1.xml';
const BOOK_NAME_LIMIT = 120;

export interface CatalogBook {
  item: Item;
  /** The formats offered, best first; at least one. */
  formats: { format: string; mediaType: string }[];
  cover?: { hash: FileHash; mediaType: string };
}

/** A file of the catalog: a feed, or a book or cover to copy in. */
export type CatalogFile =
  | { path: string; text: string }
  | { path: string; book: { itemId: ItemId; format: string } }
  | { path: string; cover: FileHash };

/** One of the user's browse categories, with the books each entry's search found. */
export interface CatalogCategory {
  name: string;
  entries: { label: string; itemIds: ItemId[] }[];
}

export interface CatalogOptions {
  title: string;
  /** Listed between Series and Tags, as calibre3opds's custom feeds. */
  categories?: CatalogCategory[];
  pageSize?: number;
  /** For the feeds' `updated`. */
  now?: string;
}

/** Lowercase ASCII words joined by dashes, for paths (as calibre3opds's `_slug`). */
export function slug(value: string): string {
  // oxlint-disable-next-line no-control-regex -- the range is "not ASCII", which includes control characters.
  const ascii = value.normalize('NFKD').replace(/[^\x00-\x7f]/g, '');
  return (
    ascii
      .replace(/[^a-zA-Z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .toLowerCase() || 'untitled'
  );
}

export const escapeXml = (text: string) =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const authorsOf = (item: Item) => {
  const authors = item.creators.filter((c) => c.role === 'aut').map((c) => c.name);
  return authors.length ? authors : item.creators.map((c) => c.name);
};
const text = (item: Item, key: string) => (typeof item.metadata[key] === 'string' ? (item.metadata[key] as string) : '');
const series = (item: Item) => text(item, 'series').trim();
const seriesIndex = (item: Item) => (typeof item.metadata.seriesIndex === 'number' ? item.metadata.seriesIndex : 0);
const byText = (a: string, b: string) => a.localeCompare(b, undefined, { sensitivity: 'base' });
const coverExtension = (mediaType: string) =>
  ({ 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp' })[mediaType] ?? 'jpg';

/** Every file of the catalog for these books. */
export function buildCatalog(books: CatalogBook[], options: CatalogOptions): CatalogFile[] {
  const pageSize = Math.max(1, options.pageSize ?? 25);
  const now = options.now ?? new Date().toISOString();
  const sorted = [...books].sort((a, b) => byText(a.item.title, b.item.title) || a.item.id.localeCompare(b.item.id));
  const recent = [...sorted].sort((a, b) => b.item.addedAt.localeCompare(a.item.addedAt));
  const files: CatalogFile[] = [];
  const stems = bookStems(sorted);
  const pages = (count: number) => Math.max(1, Math.ceil(count / pageSize));

  const link = (href: string, rel: string, type = NAVIGATION, title?: string) =>
    `<link rel="${rel}" href="${escapeXml(href.startsWith('/') ? href : `/${href}`)}" type="${type}"${
      title === undefined ? '' : ` title="${escapeXml(title)}"`
    }/>`;

  const feed = (path: string, title: string, id: string, body: string[]) => {
    files.push({
      path,
      text: [
        '<?xml version="1.0" encoding="utf-8"?>',
        `<feed xmlns="${ATOM}" xmlns:opds="${OPDS}" xmlns:dc="${DC}" xmlns:opensearch="${OPENSEARCH}" xmlns:calibre="${CALIBRE}">`,
        `<id>${escapeXml(id)}</id>`,
        `<title>${escapeXml(title)}</title>`,
        `<updated>${now}</updated>`,
        link(path, 'self', ACQUISITION),
        // Every feed offers search, as clients such as CrossPoint only search from the feed they show. The
        // description is the standard way; the template link is what Calibre's own OPDS server offers.
        link('searchDescription.xml', 'search', 'application/opensearchdescription+xml'),
        link(SEARCH_TEMPLATE, 'search', 'application/atom+xml'),
        ...body,
        '</feed>',
      ].join('\n'),
    });
  };

  const entry = ({ item, formats, cover }: CatalogBook) => {
    const lines = [
      '<entry>',
      `<id>urn:uuid:${escapeXml(item.id)}</id>`,
      `<title>${escapeXml(item.title)}</title>`,
      `<updated>${escapeXml(item.updatedAt)}</updated>`,
      ...(authorsOf(item).length ? authorsOf(item) : ['Unknown author']).map(
        (name) => `<author><name>${escapeXml(name)}</name></author>`,
      ),
    ];
    const description = text(item, 'description');
    if (description) lines.push(`<summary type="html">${escapeXml(description)}</summary>`);
    for (const tag of item.tags) {
      lines.push(`<category term="${escapeXml(tag)}" label="${escapeXml(tag)}"/>`);
      // rel "relation", as calibre3opds writes and its web client reads.
      lines.push(link(`navigation/tags/${slug(tag)}/page-1.xml`, 'relation', ACQUISITION, tag));
    }
    if (series(item)) {
      lines.push(`<calibre:series>${escapeXml(series(item))}</calibre:series>`);
      if (seriesIndex(item)) lines.push(`<calibre:series_index>${seriesIndex(item)}</calibre:series_index>`);
    }
    if (text(item, 'language')) lines.push(`<dc:language>${escapeXml(text(item, 'language'))}</dc:language>`);
    if (text(item, 'publisher')) lines.push(`<dc:publisher>${escapeXml(text(item, 'publisher'))}</dc:publisher>`);
    if (text(item, 'published')) lines.push(`<dc:issued>${escapeXml(text(item, 'published'))}</dc:issued>`);
    for (const { format, mediaType } of formats) {
      lines.push(link(`books/${stems.get(item.id)}.${format}`, 'http://opds-spec.org/acquisition', mediaType));
    }
    if (cover) {
      const href = `covers/${item.id}.${coverExtension(cover.mediaType)}`;
      lines.push(link(href, 'http://opds-spec.org/image', cover.mediaType));
      lines.push(link(href, 'http://opds-spec.org/image/thumbnail', cover.mediaType));
    }
    lines.push('</entry>');
    return lines.join('\n');
  };

  const opensearch = (total: number, start: number) => [
    `<opensearch:totalResults>${total}</opensearch:totalResults>`,
    `<opensearch:startIndex>${start}</opensearch:startIndex>`,
    `<opensearch:itemsPerPage>${pageSize}</opensearch:itemsPerPage>`,
  ];
  /** First/last/previous/next links for page `page` (0-based) of `count` in `dir`. */
  const pagination = (dir: string, page: number, count: number) => [
    ...(count > 1 ? [link(`${dir}/page-1.xml`, 'first', ACQUISITION), link(`${dir}/page-${count}.xml`, 'last', ACQUISITION)] : []),
    ...(page > 0 ? [link(`${dir}/page-${page}.xml`, 'previous', ACQUISITION)] : []),
    ...(page + 1 < count ? [link(`${dir}/page-${page + 2}.xml`, 'next', ACQUISITION)] : []),
  ];

  const paged = (dir: string, title: string, list: CatalogBook[]) => {
    const count = pages(list.length);
    for (let page = 0; page < count; page++) {
      const start = page * pageSize;
      feed(`${dir}/page-${page + 1}.xml`, title, `urn:nexlibris:${dir}:${page + 1}`, [
        link('navigation/index.xml', 'start'),
        ...opensearch(list.length, start),
        ...pagination(dir, page, count),
        ...list.slice(start, start + pageSize).map(entry),
      ]);
    }
  };

  const navigation = (path: string, title: string, entries: [string, string][]) =>
    feed(
      path,
      title,
      `urn:nexlibris:${path}`,
      entries.map(([entryTitle, href]) =>
        [
          '<entry>',
          `<id>urn:nexlibris:${escapeXml(href)}</id>`,
          `<title>${escapeXml(entryTitle)}</title>`,
          `<updated>${now}</updated>`,
          link(href, 'subsection', href.includes('/page-') ? ACQUISITION : NAVIGATION),
          '</entry>',
        ].join('\n'),
      ),
    );

  paged('navigation/titles', 'Books by title', sorted);
  paged('navigation/recent', 'Recent books', recent);

  /** Feeds per author, tag or series, each listed in its `index.xml`. */
  const grouped = (kind: string, title: string, keysOf: (b: CatalogBook) => string[], order = (list: CatalogBook[]) => list) => {
    const groups = new Map<string, { label: string; books: CatalogBook[] }>();
    for (const book of sorted) {
      for (const label of keysOf(book)) {
        // Grouped by path, so labels differing only in case or accents share a feed.
        const group = groups.get(slug(label)) ?? { label, books: [] };
        if (!group.books.includes(book)) group.books.push(book);
        groups.set(slug(label), group);
      }
    }
    const entries = [...groups].sort(([, a], [, b]) => byText(a.label, b.label));
    navigation(`navigation/${kind}/index.xml`, title, entries.map(([key, g]) => [g.label, `navigation/${kind}/${key}/page-1.xml`]));
    for (const [key, group] of entries) paged(`navigation/${kind}/${key}`, group.label, order(group.books));
  };
  grouped('authors', 'Authors', (b) => authorsOf(b.item));
  grouped('series', 'Series', (b) => (series(b.item) ? [series(b.item)] : []), (list) =>
    [...list].sort((a, b) => seriesIndex(a.item) - seriesIndex(b.item)),
  );
  grouped('tags', 'Tags', (b) => b.item.tags);

  // The user's categories: one with a single entry is its books' feed; others list their entries.
  const unique = (taken: Set<string>, base: string) => {
    let key = base;
    for (let n = 2; taken.has(key); n++) key = `${base}-${n}`;
    taken.add(key);
    return key;
  };
  const categoryKeys = new Set<string>();
  const custom = [...(options.categories ?? [])]
    .filter((category) => category.entries.length > 0)
    .sort((a, b) => byText(a.name, b.name))
    .map((category): [string, string] => {
      const dir = `navigation/custom/${unique(categoryKeys, slug(category.name))}`;
      const booksOf = (ids: ItemId[]) => sorted.filter((b) => ids.includes(b.item.id));
      if (category.entries.length === 1) {
        paged(dir, category.name, booksOf(category.entries[0]!.itemIds));
        return [category.name, `${dir}/page-1.xml`];
      }
      const entryKeys = new Set<string>();
      const entries = category.entries.map((entry) => ({ entry, key: unique(entryKeys, slug(entry.label)) }));
      navigation(`${dir}/index.xml`, category.name, entries.map(({ entry, key }) => [entry.label, `${dir}/${key}/page-1.xml`]));
      for (const { entry, key } of entries) paged(`${dir}/${key}`, entry.label, booksOf(entry.itemIds));
      return [category.name, `${dir}/index.xml`];
    });

  navigation('navigation/index.xml', options.title, [
    ['Recent books', 'navigation/recent/page-1.xml'],
    ['By title', 'navigation/titles/page-1.xml'],
    ['Authors', 'navigation/authors/index.xml'],
    ['Series', 'navigation/series/index.xml'],
    ...custom,
    ['Tags', 'navigation/tags/index.xml'],
  ]);

  const recentPages = pages(recent.length);
  feed('index.xml', options.title, 'urn:nexlibris:root', [
    link('navigation/index.xml', 'start'),
    link('navigation/index.xml', 'subsection', NAVIGATION, 'Browse'),
    ...opensearch(recent.length, 0),
    ...pagination('navigation/recent', 0, recentPages),
    ...recent.slice(0, pageSize).map(entry),
  ]);

  // Search: a feed per term, since a static host can't run a query.
  const terms = new Map<string, CatalogBook[]>();
  for (const book of sorted) {
    const values = [book.item.title, ...book.item.tags, ...authorsOf(book.item), series(book.item)].filter(Boolean);
    for (const term of new Set(values.map(slug))) terms.set(term, [...(terms.get(term) ?? []), book]);
  }
  const termList = [...terms.keys()].sort();
  navigation('search.xml', 'Search', termList.map((term) => [`Search: ${term}`, `search/${term}/page-1.xml`]));
  for (const term of termList) paged(`search/${term}`, `Search: ${term}`, terms.get(term)!);
  files.push({
    path: 'searchDescription.xml',
    text: [
      '<?xml version="1.0" encoding="utf-8"?>',
      `<OpenSearchDescription xmlns="${OPENSEARCH}">`,
      `<ShortName>${escapeXml(options.title.slice(0, 16))}</ShortName>`,
      '<Description>Search titles, tags, authors and series</Description>',
      `<Url type="application/atom+xml" template="${SEARCH_TEMPLATE}"/>`,
      '</OpenSearchDescription>',
    ].join('\n'),
  });

  for (const { item, formats, cover } of sorted) {
    for (const { format } of formats) files.push({ path: `books/${stems.get(item.id)}.${format}`, book: { itemId: item.id, format } });
    if (cover) files.push({ path: `covers/${item.id}.${coverExtension(cover.mediaType)}`, cover: cover.hash });
  }
  return files;
}

/** `<title>_<author>-<author>`, slugged and unique (as calibre3opds names books). */
function bookStems(books: CatalogBook[]): Map<ItemId, string> {
  const stems = new Map<ItemId, string>();
  const used = new Set<string>();
  for (const { item } of books) {
    const authors = authorsOf(item).map(slug).join('_');
    const base = `${slug(item.title)}_${authors || 'unknown-author'}`.slice(0, BOOK_NAME_LIMIT);
    let stem = base;
    for (let n = 2; used.has(stem); n++) stem = `${base.slice(0, BOOK_NAME_LIMIT - `-${n}`.length)}-${n}`;
    used.add(stem);
    stems.set(item.id, stem);
  }
  return stems;
}
