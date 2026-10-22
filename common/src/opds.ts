import { userData } from './operations';
import { filterItems } from './search';
import { FORMATS, isFormatId } from '@nexlibris/tools/formats/formats';
import type { FileHash, FileRef, Item, ItemId, Library } from './types';

/**
 * OPDS feeds of the library's books, as servers serve them live (`opdsServer.ts`): the books
 * arranged as the Library browses them (`arrangeFeeds`: recent, by title, authors, series, the
 * user's categories, tags), feeds of them as pages (`bookPage`, `navigationPage`), and each page
 * written as OPDS 1.2, an Atom feed (`atomFeed`), or OPDS 2.0, JSON (`opds2Feed`). Where a page's
 * links lead is up to whoever builds it.
 */

const ATOM = 'http://www.w3.org/2005/Atom';
const OPDS = 'http://opds-spec.org/2010/catalog';
const DC = 'http://purl.org/dc/terms/';
const OPENSEARCH = 'http://a9.com/-/spec/opensearch/1.1/';
const CALIBRE = 'http://calibre-ebook.com';
export const OPDS_NAVIGATION = 'application/atom+xml;profile=opds-catalog;kind=navigation';
export const OPDS_ACQUISITION = 'application/atom+xml;profile=opds-catalog;kind=acquisition';
export const OPDS_JSON = 'application/opds+json';
export const OPENSEARCH_DESCRIPTION = 'application/opensearchdescription+xml';
const ACQUIRE = 'http://opds-spec.org/acquisition';
const IMAGE = 'http://opds-spec.org/image';
const THUMBNAIL = 'http://opds-spec.org/image/thumbnail';

export interface FeedBook {
  item: Item;
  /** The formats offered, best first; at least one. */
  formats: { format: string; mediaType: string; hash?: FileHash }[];
  cover?: { hash: FileHash; mediaType: string };
}

/** An item offered as these of its files. */
export const feedBook = (item: Item, files: FileRef[]): FeedBook => ({
  item,
  formats: files.map(({ format, hash }) => ({
    format,
    mediaType: isFormatId(format) ? FORMATS[format].mediaType : 'application/octet-stream',
    hash,
  })),
  ...(item.cover && { cover: item.cover }),
});

/** One of the user's browse categories, with the books each entry's search found. */
export interface FeedCategory {
  name: string;
  entries: { label: string; itemIds: ItemId[] }[];
}

/** Lowercase ASCII words joined by dashes, for paths. */
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

export const authorsOf = (item: Item) => {
  const authors = item.creators.filter((c) => c.role === 'aut').map((c) => c.name);
  return authors.length ? authors : item.creators.map((c) => c.name);
};
const text = (item: Item, key: string) => (typeof item.metadata[key] === 'string' ? (item.metadata[key] as string) : '');
export const seriesOf = (item: Item) => text(item, 'series').trim();
const seriesIndex = (item: Item) => (typeof item.metadata.seriesIndex === 'number' ? item.metadata.seriesIndex : 0);
const byText = (a: string, b: string) => a.localeCompare(b, undefined, { sensitivity: 'base' });

/** The user's browse categories (`Library.categories`), each entry's search run over these items. */
export function feedCategories(library: Library, items: Item[]): FeedCategory[] {
  const { ratings } = userData(library);
  return Object.values(library.categories ?? {}).map((category) => ({
    name: category.name,
    entries: category.entries.map((entry) => ({
      label: entry.label || entry.query,
      itemIds: filterItems(items, entry.query, { ratings }).map((i) => i.id),
    })),
  }));
}

export interface FeedGroup {
  /** Its part of a path: the slug of its label. Labels differing only in case or accents share a group. */
  key: string;
  label: string;
  books: FeedBook[];
}

export interface FeedCategoryGroups {
  key: string;
  name: string;
  /** One entry is the category's books; several are listed. */
  entries: FeedGroup[];
}

/** A catalog's books arranged for browsing. */
export interface ArrangedFeeds {
  /** By title. */
  books: FeedBook[];
  /** Last added first. */
  recent: FeedBook[];
  authors: FeedGroup[];
  /** Each series's books in order. */
  series: FeedGroup[];
  tags: FeedGroup[];
  /** The user's categories with any books, by name. */
  categories: FeedCategoryGroups[];
}

/** A key not yet taken, the base or it numbered. */
function unique(taken: Set<string>, base: string) {
  let key = base;
  for (let n = 2; taken.has(key); n++) key = `${base}-${n}`;
  taken.add(key);
  return key;
}

export function arrangeFeeds(books: FeedBook[], categories: FeedCategory[] = []): ArrangedFeeds {
  const sorted = [...books].sort((a, b) => byText(a.item.title, b.item.title) || a.item.id.localeCompare(b.item.id));
  const recent = [...sorted].sort((a, b) => b.item.addedAt.localeCompare(a.item.addedAt));

  const grouped = (keysOf: (b: FeedBook) => string[], order = (list: FeedBook[]) => list): FeedGroup[] => {
    const groups = new Map<string, FeedGroup>();
    for (const book of sorted) {
      for (const label of keysOf(book)) {
        const key = slug(label);
        const group = groups.get(key) ?? { key, label, books: [] };
        if (!group.books.includes(book)) group.books.push(book);
        groups.set(key, group);
      }
    }
    return [...groups.values()].sort((a, b) => byText(a.label, b.label)).map((group) => ({ ...group, books: order(group.books) }));
  };

  const categoryKeys = new Set<string>();
  const booksOf = (ids: ItemId[]) => sorted.filter((b) => ids.includes(b.item.id));
  return {
    books: sorted,
    recent,
    authors: grouped((b) => authorsOf(b.item)),
    series: grouped(
      (b) => (seriesOf(b.item) ? [seriesOf(b.item)] : []),
      (list) => [...list].sort((a, b) => seriesIndex(a.item) - seriesIndex(b.item)),
    ),
    tags: grouped((b) => b.item.tags),
    categories: categories
      .filter((category) => category.entries.length > 0)
      .sort((a, b) => byText(a.name, b.name))
      .map((category) => {
        const entryKeys = new Set<string>();
        return {
          key: unique(categoryKeys, slug(category.name)),
          name: category.name,
          entries: category.entries.map((entry) => ({ key: unique(entryKeys, slug(entry.label)), label: entry.label, books: booksOf(entry.itemIds) })),
        };
      }),
  };
}

/** A book as a page shows it, with where its files and cover are. */
export interface OpdsPublication {
  book: FeedBook;
  /** Where each of its formats is downloaded, as `book.formats`. */
  acquisitions: { href: string; type: string }[];
  cover?: { href: string; type: string };
  /** The feed of a tag's books, if there's one to link to. */
  tagHref?: (tag: string) => string;
}

export interface OpdsNavigationEntry {
  title: string;
  href: string;
  /** What it leads to: more places, or books. */
  kind: 'navigation' | 'acquisition';
  /** How many books or places, where it's known. */
  count?: number;
}

/** One feed of a catalog: places to go, or a page of books. Every address in it is final. */
export interface OpdsPage {
  id: string;
  title: string;
  /** For the feed's `updated`. */
  updated: string;
  kind: 'navigation' | 'acquisition';
  self: string;
  /** The catalog's first page. */
  start: string;
  /**
   * How to search: an OpenSearch description, and a template whose `{searchTerms}` (Atom) or
   * `{?query}` (OPDS 2) is replaced by the words.
   */
  search?: { description?: string; template?: string };
  /** For a page of books: how many there are in all, and the pages around it. */
  pagination?: { total: number; start: number; pageSize: number; first?: string; last?: string; previous?: string; next?: string };
  navigation: OpdsNavigationEntry[];
  publications: OpdsPublication[];
}

/** A page of a list of books: `page` from 0, `href(n)` page n's address (also from 0). */
export function bookPage(
  base: Omit<OpdsPage, 'kind' | 'self' | 'pagination' | 'navigation' | 'publications'>,
  list: FeedBook[],
  page: number,
  pageSize: number,
  href: (page: number) => string,
  publication: (book: FeedBook) => OpdsPublication,
): OpdsPage {
  const count = Math.max(1, Math.ceil(list.length / pageSize));
  const start = page * pageSize;
  return {
    ...base,
    kind: 'acquisition',
    self: href(page),
    pagination: {
      total: list.length,
      start,
      pageSize,
      ...(count > 1 && { first: href(0), last: href(count - 1) }),
      ...(page > 0 && { previous: href(page - 1) }),
      ...(page + 1 < count && { next: href(page + 1) }),
    },
    navigation: [],
    publications: list.slice(start, start + pageSize).map(publication),
  };
}

/** How many pages a list of books takes. */
export const pageCount = (count: number, pageSize: number) => Math.max(1, Math.ceil(count / pageSize));

/** A feed of places. */
export const navigationPage = (
  base: Omit<OpdsPage, 'kind' | 'navigation' | 'publications'>,
  entries: OpdsNavigationEntry[],
): OpdsPage => ({ ...base, kind: 'navigation', navigation: entries, publications: [] });

const atomType = (kind: OpdsPage['kind']) => (kind === 'navigation' ? OPDS_NAVIGATION : OPDS_ACQUISITION);

const atomLink = (href: string, rel: string, type: string, title?: string) =>
  `<link rel="${rel}" href="${escapeXml(href)}" type="${type}"${title === undefined ? '' : ` title="${escapeXml(title)}"`}/>`;

/** A book's Atom entry. */
function atomEntry({ book: { item }, acquisitions, cover, tagHref }: OpdsPublication): string {
  const lines = [
    '<entry>',
    `<id>urn:uuid:${escapeXml(item.id)}</id>`,
    `<title>${escapeXml(item.title)}</title>`,
    `<updated>${escapeXml(item.updatedAt)}</updated>`,
    ...(authorsOf(item).length ? authorsOf(item) : ['Unknown author']).map((name) => `<author><name>${escapeXml(name)}</name></author>`),
  ];
  const description = text(item, 'description');
  if (description) lines.push(`<summary type="html">${escapeXml(description)}</summary>`);
  for (const tag of item.tags) {
    lines.push(`<category term="${escapeXml(tag)}" label="${escapeXml(tag)}"/>`);
    // rel "relation", as calibre's server and calibre3opds write it.
    if (tagHref) lines.push(atomLink(tagHref(tag), 'relation', OPDS_ACQUISITION, tag));
  }
  if (seriesOf(item)) {
    lines.push(`<calibre:series>${escapeXml(seriesOf(item))}</calibre:series>`);
    if (seriesIndex(item)) lines.push(`<calibre:series_index>${seriesIndex(item)}</calibre:series_index>`);
  }
  if (text(item, 'language')) lines.push(`<dc:language>${escapeXml(text(item, 'language'))}</dc:language>`);
  if (text(item, 'publisher')) lines.push(`<dc:publisher>${escapeXml(text(item, 'publisher'))}</dc:publisher>`);
  if (text(item, 'published')) lines.push(`<dc:issued>${escapeXml(text(item, 'published'))}</dc:issued>`);
  for (const { href, type } of acquisitions) lines.push(atomLink(href, ACQUIRE, type));
  if (cover) {
    lines.push(atomLink(cover.href, IMAGE, cover.type));
    lines.push(atomLink(cover.href, THUMBNAIL, cover.type));
  }
  lines.push('</entry>');
  return lines.join('\n');
}

/** A page as an OPDS 1.2 Atom feed. */
export function atomFeed(page: OpdsPage): string {
  const { pagination: p } = page;
  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    `<feed xmlns="${ATOM}" xmlns:opds="${OPDS}" xmlns:dc="${DC}" xmlns:opensearch="${OPENSEARCH}" xmlns:calibre="${CALIBRE}">`,
    `<id>${escapeXml(page.id)}</id>`,
    `<title>${escapeXml(page.title)}</title>`,
    `<updated>${page.updated}</updated>`,
    atomLink(page.self, 'self', atomType(page.kind)),
    atomLink(page.start, 'start', OPDS_NAVIGATION),
    // Every feed offers search, as clients such as CrossPoint only search from the feed they show. The
    // description is the standard way; the template link is what Calibre's own OPDS server offers.
    ...(page.search?.description ? [atomLink(page.search.description, 'search', OPENSEARCH_DESCRIPTION)] : []),
    ...(page.search?.template ? [atomLink(page.search.template, 'search', 'application/atom+xml')] : []),
    ...(p
      ? [
          `<opensearch:totalResults>${p.total}</opensearch:totalResults>`,
          `<opensearch:startIndex>${p.start}</opensearch:startIndex>`,
          `<opensearch:itemsPerPage>${p.pageSize}</opensearch:itemsPerPage>`,
          ...(p.first ? [atomLink(p.first, 'first', OPDS_ACQUISITION)] : []),
          ...(p.last ? [atomLink(p.last, 'last', OPDS_ACQUISITION)] : []),
          ...(p.previous ? [atomLink(p.previous, 'previous', OPDS_ACQUISITION)] : []),
          ...(p.next ? [atomLink(p.next, 'next', OPDS_ACQUISITION)] : []),
        ]
      : []),
    ...page.navigation.map((entry) =>
      [
        '<entry>',
        `<id>urn:nexlibris:${escapeXml(entry.href)}</id>`,
        `<title>${escapeXml(entry.title)}</title>`,
        `<updated>${page.updated}</updated>`,
        ...(entry.count === undefined ? [] : [`<content type="text">${entry.count} ${entry.count === 1 ? 'book' : 'books'}</content>`]),
        atomLink(entry.href, 'subsection', atomType(entry.kind)),
        '</entry>',
      ].join('\n'),
    ),
    ...page.publications.map((publication) => atomEntry(publication)),
    '</feed>',
  ].join('\n');
}

/** An OpenSearch description of a template (`{searchTerms}`) answered with Atom feeds. */
export const openSearchDescription = (title: string, template: string) =>
  [
    '<?xml version="1.0" encoding="utf-8"?>',
    `<OpenSearchDescription xmlns="${OPENSEARCH}">`,
    `<ShortName>${escapeXml(title.slice(0, 16))}</ShortName>`,
    '<Description>Search titles, tags, authors and series</Description>',
    `<Url type="application/atom+xml" template="${escapeXml(template)}"/>`,
    '</OpenSearchDescription>',
  ].join('\n');

type JsonLink = { href: string; type: string; rel?: string; title?: string; templated?: true; properties?: Record<string, unknown> };

/** A book as an OPDS 2.0 publication. */
export function opds2Publication({ book: { item }, acquisitions, cover, tagHref }: OpdsPublication) {
  const description = text(item, 'description');
  const series = seriesOf(item);
  return {
    metadata: {
      '@type': 'http://schema.org/Book',
      identifier: `urn:uuid:${item.id}`,
      title: item.title,
      ...(authorsOf(item).length && { author: authorsOf(item).map((name) => ({ name })) }),
      modified: item.updatedAt,
      ...(text(item, 'published') && { published: text(item, 'published') }),
      ...(text(item, 'language') && { language: text(item, 'language') }),
      ...(text(item, 'publisher') && { publisher: text(item, 'publisher') }),
      ...(description && { description }),
      ...(item.tags.length && {
        subject: item.tags.map((name) => ({ name, ...(tagHref && { links: [{ href: tagHref(name), type: OPDS_JSON }] }) })),
      }),
      ...(series && { belongsTo: { series: [{ name: series, ...(seriesIndex(item) && { position: seriesIndex(item) }) }] } }),
    },
    links: acquisitions.map(({ href, type }): JsonLink => ({ rel: ACQUIRE, href, type })),
    ...(cover && { images: [{ href: cover.href, type: cover.type }] }),
  };
}

/** A page as an OPDS 2.0 feed (JSON, as an object). */
export function opds2Feed(page: OpdsPage) {
  const { pagination: p } = page;
  const link = (rel: string, href: string): JsonLink => ({ rel, href, type: OPDS_JSON });
  const navigation = page.navigation.map(
    ({ title, href, count }): JsonLink => ({ href, title, type: OPDS_JSON, rel: 'subsection', ...(count !== undefined && { properties: { numberOfItems: count } }) }),
  );
  return {
    metadata: {
      title: page.title,
      modified: page.updated,
      ...(p && { numberOfItems: p.total, itemsPerPage: p.pageSize, currentPage: Math.floor(p.start / p.pageSize) + 1 }),
    },
    links: [
      link('self', page.self),
      link('start', page.start),
      ...(page.search?.template ? [{ ...link('search', page.search.template), templated: true as const }] : []),
      ...(p?.first ? [link('first', p.first)] : []),
      ...(p?.last ? [link('last', p.last)] : []),
      ...(p?.previous ? [link('previous', p.previous)] : []),
      ...(p?.next ? [link('next', p.next)] : []),
    ],
    // A feed has at least one collection; a page of books always has its (perhaps empty) list.
    ...(navigation.length && { navigation }),
    ...((page.kind === 'acquisition' || !navigation.length) && { publications: page.publications.map(opds2Publication) }),
  };
}
