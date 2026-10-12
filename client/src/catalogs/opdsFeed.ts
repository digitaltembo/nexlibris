import { formatFromName, type FormatId } from '../formats/formats';
import { parseXml } from '../formats/xml';

/**
 * Reading OPDS 1 catalogs (Atom feeds), as served by Project Gutenberg, calibre's content server,
 * COPS and the like, for browsing them (`catalogs/`). A feed's entries are books, which have
 * acquisition links to download them, or links on to other feeds (navigation: "Popular", an
 * author, or, at Gutenberg, a book's own feed with its downloads). Links are made absolute.
 */

export interface OpdsDownload {
  href: string;
  type: string;
  /** What the server calls it, e.g. "EPUB (no images)". */
  title?: string;
  /** In bytes, where the server says. */
  length?: number;
  /** The library's format for it, where nexlibris reads it. */
  format?: FormatId;
}

export interface OpdsLinkTo {
  href: string;
  title: string;
}

export interface OpdsBook {
  kind: 'book';
  id: string;
  title: string;
  authors: string[];
  /** The description, as HTML (untrusted: render it with `RichText`). */
  summary?: string;
  cover?: string;
  thumbnail?: string;
  /** Best first: an EPUB if there is one. */
  downloads: OpdsDownload[];
  /** Feeds about it: its author's books, its subjects. */
  related: OpdsLinkTo[];
  tags: string[];
  language?: string;
  /** When it was published (`dc:issued`, else Atom's `published`). */
  published?: string;
  publisher?: string;
  /** calibre's `series` and `series_index`, as calibre's server and nexlibris's export write them. */
  series?: string;
  seriesIndex?: number;
  /** When the catalog last changed it (Atom's `updated`). */
  updated?: string;
  rights?: string;
  /** `dc:identifier`s, e.g. `urn:isbn:…`. */
  identifiers: string[];
}

export interface OpdsNavigation {
  kind: 'navigation';
  id: string;
  title: string;
  /** Its text, e.g. a book's author at Gutenberg, or how many books. */
  detail?: string;
  href: string;
  thumbnail?: string;
}

export type OpdsEntry = OpdsBook | OpdsNavigation;

export interface OpdsFeed {
  url: string;
  title: string;
  subtitle?: string;
  entries: OpdsEntry[];
  /** The next page, if there is one. */
  next?: string;
  /** Places the feed itself links to (its sections), beside its entries. */
  sections: OpdsLinkTo[];
  /** How to search the catalog: an OpenSearch description to read, or a template with `{searchTerms}`. */
  search?: { description?: string; template?: string };
}

const ACQUISITION = 'http://opds-spec.org/acquisition';
const IMAGE = 'http://opds-spec.org/image';
const THUMBNAIL = 'http://opds-spec.org/image/thumbnail';

/** Media types of books, to formats (`formatFromName` covers the rest by the link's file name). */
const TYPES: Record<string, FormatId> = {
  'application/epub+zip': 'epub',
  'application/pdf': 'pdf',
  'application/x-mobipocket-ebook': 'mobi',
  'application/x-mobi8-ebook': 'azw3',
  'application/vnd.amazon.mobi8-ebook': 'azw3',
  'application/vnd.amazon.ebook': 'azw',
  'application/vnd.comicbook+zip': 'cbz',
  'application/x-cbz': 'cbz',
  'application/vnd.comicbook-rar': 'cbr',
  'application/x-cbr': 'cbr',
  'application/rtf': 'rtf',
  'text/rtf': 'rtf',
  'text/plain': 'txt',
};

/** Formats in the order a book's downloads are offered: the library's preference. */
const PREFERENCE: FormatId[] = ['epub', 'azw3', 'mobi', 'azw', 'pdf', 'cbz', 'cbr', 'rtf', 'txt'];

const kids = (el: Element, name: string) => [...el.children].filter((c) => c.localName === name);
const kid = (el: Element, name: string) => kids(el, name)[0];
const text = (el: Element | undefined) => el?.textContent?.replace(/\s+/g, ' ').trim() || undefined;
const isFeed = (type: string) => /atom\+xml|opds-catalog|opds\+json/.test(type);

/** A link's address, absolute, if it's one nexlibris may follow (http, https, or an image's data). */
function absolute(href: string | null, base: string): string | undefined {
  if (!href) return undefined;
  try {
    const url = new URL(href, base);
    if (url.protocol === 'http:' || url.protocol === 'https:' || (url.protocol === 'data:' && href.startsWith('data:image/'))) return url.href;
  } catch {
    // Not an address.
  }
  return undefined;
}

interface Link {
  href: string;
  rel: string;
  type: string;
  title?: string;
  length?: number;
}

function links(el: Element, base: string): Link[] {
  return kids(el, 'link').flatMap((link) => {
    const href = absolute(link.getAttribute('href'), base);
    if (!href) return [];
    const length = Number(link.getAttribute('length'));
    return [
      {
        href,
        rel: link.getAttribute('rel') ?? '',
        type: (link.getAttribute('type') ?? '').toLowerCase(),
        ...(link.getAttribute('title') && { title: link.getAttribute('title')! }),
        ...(length > 0 && { length }),
      },
    ];
  });
}

/** An entry's content or summary as HTML. */
function html(el: Element | undefined): string | undefined {
  if (!el) return undefined;
  const type = el.getAttribute('type') ?? 'text';
  if (type === 'xhtml') {
    const div = el.firstElementChild;
    return (div?.localName === 'div' ? div.innerHTML : el.innerHTML).trim() || undefined;
  }
  // `html` content is escaped HTML, so its text is the HTML; plain text is HTML-safe once escaped.
  const content = el.textContent?.trim();
  if (!content) return undefined;
  return type === 'html' ? content : content.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/\n{2,}/g, '<br><br>');
}

function formatOf(link: Link): FormatId | undefined {
  const type = link.type.split(';')[0]!.trim();
  const named = formatFromName(new URL(link.href).pathname);
  // A file named for a particular reader (`.x4.epub`) is that, though it's served as any EPUB.
  if (named?.includes('.')) return named;
  return TYPES[type] ?? named;
}

function entryOf(el: Element, base: string, index: number): OpdsEntry {
  const all = links(el, base);
  const title = text(kid(el, 'title')) ?? 'Untitled';
  const id = text(kid(el, 'id')) ?? `${base}#${index}`;
  const downloads = all
    .filter((l) => l.rel.startsWith(ACQUISITION) && l.rel !== `${ACQUISITION}/subscribe`)
    .map((l): OpdsDownload => {
      const format = formatOf(l);
      return { href: l.href, type: l.type, ...(l.title && { title: l.title }), ...(l.length && { length: l.length }), ...(format && { format }) };
    })
    .sort((a, b) => rank(a) - rank(b));
  const thumbnail = all.find((l) => l.rel === THUMBNAIL || l.rel === `${IMAGE}-thumbnail`)?.href;
  const feedLinks = all.filter((l) => isFeed(l.type) && l.rel !== 'self' && l.rel !== 'alternate' && l.rel !== 'start' && l.rel !== 'up');
  if (!downloads.length && feedLinks.length) {
    const to = feedLinks.find((l) => !l.rel || l.rel === 'subsection' || l.rel.startsWith('http://opds-spec.org/')) ?? feedLinks[0]!;
    const detail = text(kid(el, 'content')) ?? text(kid(el, 'summary'));
    return { kind: 'navigation', id, title, href: to.href, ...(detail && { detail }), ...(thumbnail && { thumbnail }) };
  }
  const authors = kids(el, 'author').flatMap((a) => text(kid(a, 'name')) ?? []);
  const summary = html(kid(el, 'content')) ?? html(kid(el, 'summary'));
  const cover = all.find((l) => l.rel === IMAGE || l.rel === 'http://opds-spec.org/cover')?.href;
  const tags = [...new Set(kids(el, 'category').flatMap((c) => c.getAttribute('label') || c.getAttribute('term') || text(c) || []))];
  const language = text(kid(el, 'language'));
  const published = text(kid(el, 'issued')) ?? text(kid(el, 'published'));
  const publisher = text(kid(el, 'publisher'));
  const series = text(kid(el, 'series'));
  const seriesIndex = Number(text(kid(el, 'series_index')));
  const updated = text(kid(el, 'updated'));
  const rights = text(kid(el, 'rights'));
  return {
    kind: 'book',
    id,
    title,
    authors,
    downloads,
    related: feedLinks.map((l) => ({ href: l.href, title: l.title ?? l.href })),
    tags,
    identifiers: kids(el, 'identifier').flatMap((i) => text(i) ?? []),
    ...(summary && { summary }),
    ...(cover && { cover }),
    ...((thumbnail ?? cover) && { thumbnail: thumbnail ?? cover }),
    ...(language && { language }),
    ...(published && { published }),
    ...(publisher && { publisher }),
    ...(series && { series }),
    ...(series && Number.isFinite(seriesIndex) && seriesIndex > 0 && { seriesIndex }),
    ...(updated && { updated }),
    ...(rights && { rights }),
  };
}

/** Feed links that are about this page rather than places to go. */
const NOT_SECTIONS = new Set(['self', 'start', 'alternate', 'search', 'next', 'previous', 'prev', 'first', 'last', 'up']);

/** A name for a section link that has no title, by what it's for. */
function sectionName(rel: string): string {
  const kind = rel.replace('http://opds-spec.org/', '').replace(/^sort\//, '');
  const names: Record<string, string> = { start: 'Start', subsection: 'Browse', new: 'New', popular: 'Popular', featured: 'Featured', recommended: 'Recommended', shelf: 'Shelf' };
  return names[kind] ?? 'Browse';
}

const rank = (download: OpdsDownload) => {
  const i = download.format ? PREFERENCE.indexOf(download.format) : -1;
  return i < 0 ? PREFERENCE.length : i;
};

/** Parses an OPDS 1 feed fetched from `url`. Throws if it isn't one. */
export function parseOpdsFeed(xml: string, url: string): OpdsFeed {
  const doc = parseXml(xml);
  const root = doc?.documentElement;
  if (!root || root.localName !== 'feed') throw new Error('That address doesn’t serve an OPDS catalog (an Atom feed).');
  const own = links(root, url);
  const next = own.find((l) => l.rel === 'next')?.href;
  const self = own.find((l) => l.rel === 'self')?.href ?? url;
  const sections = own
    .filter((l) => isFeed(l.type) && !NOT_SECTIONS.has(l.rel) && l.href !== self && l.href !== url)
    .map((l) => ({ href: l.href, title: l.title ?? sectionName(l.rel) }));
  const searchLinks = own.filter((l) => l.rel === 'search');
  const description = searchLinks.find((l) => l.type.includes('opensearchdescription'))?.href;
  const template = searchLinks.find((l) => l.href.includes('%7BsearchTerms%7D') || l.href.includes('{searchTerms}'))?.href;
  const subtitle = text(kid(root, 'subtitle'));
  return {
    url,
    title: text(kid(root, 'title')) ?? 'Catalog',
    entries: kids(root, 'entry').map((el, i) => entryOf(el, url, i)),
    sections,
    ...(subtitle && { subtitle }),
    ...(next && { next }),
    ...((description || template) && {
      search: { ...(description && { description }), ...(template && { template: template.replace(/%7B/gi, '{').replace(/%7D/gi, '}') }) },
    }),
  };
}

/** The search template an OpenSearch description gives for OPDS (Atom) results. */
export function parseOpenSearch(xml: string, url: string): string | undefined {
  const root = parseXml(xml)?.documentElement;
  if (!root) return undefined;
  const urls = kids(root, 'Url').map((u) => ({ type: (u.getAttribute('type') ?? '').toLowerCase(), template: u.getAttribute('template') ?? '' }));
  const found = urls.find((u) => u.type.includes('opds-catalog')) ?? urls.find((u) => u.type.includes('atom+xml'));
  if (!found?.template) return undefined;
  // Made absolute, keeping the braces URL parsing would escape.
  try {
    const absoluteTemplate = new URL(found.template, url).href;
    return absoluteTemplate.replace(/%7B/gi, '{').replace(/%7D/gi, '}');
  } catch {
    return undefined;
  }
}

/** A search template filled in: the terms, and nothing for the optional parameters (`{startPage?}`). */
export const fillTemplate = (template: string, terms: string) =>
  template.replace(/\{searchTerms\??\}/g, encodeURIComponent(terms)).replace(/\{[^}]+\}/g, '');
