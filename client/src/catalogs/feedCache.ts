import { hashBlob, type LibraryBackend } from '@nexlibris/common';
import { fillTemplate, parseOpdsFeed, parseOpenSearch, type OpdsFeed } from './opdsFeed';
import type { TextFetcher } from './remote';

/**
 * Catalog pages as last read, kept in this instance's local files (`opds/<hash of the address>.json`;
 * not synced or backed up), so browsing a catalog again reads nothing from its server for a day.
 * After that, a page shown is checked with the server (a conditional request where the transport
 * can make one) and kept if it's unchanged. Only what the user opens or asks for more of is read:
 * nothing crawls a catalog.
 */

/** How long a page is shown as it was without checking it. */
export const CHECK_AFTER_MS = 24 * 60 * 60 * 1000;

export interface CachedFeed {
  url: string;
  feed: OpdsFeed;
  /** Of the page's text, to tell whether it changed. */
  digest: string;
  etag?: string;
  lastModified?: string;
  /** When it was read, and when last found unchanged. */
  fetchedAt: string;
  checkedAt: string;
  /** How many pages of this feed were loaded (Load more), to show as many again. */
  pages?: number;
  /** For a catalog's first page: the search template its OpenSearch description gives, once read. */
  searchTemplate?: string;
}

export interface Loaded {
  cached: CachedFeed;
  /** Couldn't be checked: shown as it was, with why. */
  stale?: string;
}

const hex = (bytes: ArrayBuffer) => Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, '0')).join('');
const keyOf = async (url: string) => `opds/${hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(url)))}.json`;
const digestOf = (text: string) => hashBlob(new Blob([text]));

export async function readCachedFeed(backend: LibraryBackend, url: string): Promise<CachedFeed | undefined> {
  try {
    const blob = await backend.readLocalFile(await keyOf(url));
    return blob ? (JSON.parse(await blob.text()) as CachedFeed) : undefined;
  } catch {
    return undefined;
  }
}

async function writeCachedFeed(backend: LibraryBackend, cached: CachedFeed): Promise<void> {
  await backend.writeLocalFile(await keyOf(cached.url), new Blob([JSON.stringify(cached)], { type: 'application/json' }));
}

export const isFresh = (cached: CachedFeed, now = new Date()) => now.getTime() - Date.parse(cached.checkedAt) < CHECK_AFTER_MS;

/** The server answered, but not with a page. */
export class FeedError extends Error {
  constructor(readonly status: number) {
    super(
      status === 401 || status === 403
        ? 'The catalog needs a sign-in, or refused the one given: check the user name and password in the connection’s settings.'
        : status === 404
          ? 'The catalog has nothing at that address (404).'
          : `The catalog’s server said ${status}.`,
    );
    this.name = 'FeedError';
  }
}

const failure = (status: number) => new FeedError(status);

/** Reads a page from the server, or finds the cached one unchanged, and caches the result. */
async function refetch(backend: LibraryBackend, url: string, fetcher: TextFetcher, cached: CachedFeed | undefined, now: Date) {
  const headers: Record<string, string> = {};
  if (cached?.etag) headers['If-None-Match'] = cached.etag;
  if (cached?.lastModified) headers['If-Modified-Since'] = cached.lastModified;
  const response = await fetcher(url, Object.keys(headers).length ? headers : undefined);
  const checkedAt = now.toISOString();
  if (cached && response.status === 304) return { ...cached, checkedAt };
  if (response.status < 200 || response.status >= 300) throw failure(response.status);
  const digest = await digestOf(response.text);
  if (cached && digest === cached.digest) return { ...cached, checkedAt };
  const feed = parseOpdsFeed(response.text, response.url || url);
  return {
    url,
    feed,
    digest,
    ...(response.etag && { etag: response.etag }),
    ...(response.lastModified && { lastModified: response.lastModified }),
    fetchedAt: checkedAt,
    checkedAt,
    ...(cached?.pages && { pages: cached.pages }),
    ...(cached?.searchTemplate && { searchTemplate: cached.searchTemplate }),
  };
}

/**
 * A catalog page: the cached one if it was read or checked in the last day (unless `check`), else
 * checked with the server. If the server can't be reached, the cached page is given, `stale`.
 */
export async function loadFeed(
  backend: LibraryBackend,
  url: string,
  fetcher: TextFetcher,
  { now = new Date(), check = false }: { now?: Date; check?: boolean } = {},
): Promise<Loaded> {
  const cached = await readCachedFeed(backend, url);
  if (cached && !check && isFresh(cached, now)) return { cached };
  try {
    const next = await refetch(backend, url, fetcher, cached, now);
    await writeCachedFeed(backend, next);
    return { cached: next };
  } catch (e) {
    if (!cached) throw e;
    return { cached, stale: e instanceof Error ? e.message : String(e) };
  }
}

/** Remembers how many pages of a feed were loaded, so it shows as many next time. */
export async function rememberPages(backend: LibraryBackend, url: string, pages: number): Promise<void> {
  const cached = await readCachedFeed(backend, url);
  if (cached && cached.pages !== pages) await writeCachedFeed(backend, { ...cached, pages });
}

/** The same address on the catalog's own server: for a search template naming a mirror that's gone (as Gutenberg's does). */
function onHost(url: string, root: string): string | undefined {
  const target = new URL(url);
  const home = new URL(root);
  if (target.host === home.host) return undefined;
  target.protocol = home.protocol;
  target.host = home.host;
  return target.href;
}

/** A catalog's search template, from its first page or the OpenSearch description it names (read once, then kept). */
export async function searchTemplate(backend: LibraryBackend, root: string, fetcher: TextFetcher): Promise<string | undefined> {
  const { cached } = await loadFeed(backend, root, fetcher);
  if (cached.searchTemplate) return cached.searchTemplate;
  const search = cached.feed.search;
  if (search?.template) return search.template;
  if (!search?.description) return undefined;
  let response;
  try {
    response = await fetcher(search.description);
  } catch {
    throw new Error(
      'Couldn’t read how to search this catalog (its OpenSearch description). Give a search address in the connection’s settings to search it from here.',
    );
  }
  if (response.status < 200 || response.status >= 300) throw failure(response.status);
  let template = parseOpenSearch(response.text, response.url || search.description);
  // A page from a server that's https can't load from one that isn't, and the catalog's own is the likeliest to answer.
  if (template && new URL(root).protocol === 'https:' && template.startsWith('http:')) template = `https:${template.slice(5)}`;
  if (template) await writeCachedFeed(backend, { ...((await readCachedFeed(backend, root)) ?? cached), searchTemplate: template });
  return template;
}

/** Whether a catalog offers search, by what's known of it here without asking its server. */
export async function canSearch(backend: LibraryBackend, root: string, override?: string): Promise<boolean> {
  if (override) return true;
  const cached = await readCachedFeed(backend, root);
  return !!(cached?.searchTemplate || cached?.feed.search);
}

/**
 * The results of searching a catalog for `terms`: its first page, loaded as any page is. If the
 * search's server can't be reached and it isn't the catalog's own, the catalog's own is tried with
 * the same address (and kept as the template if it answers).
 */
export async function loadSearch(
  backend: LibraryBackend,
  root: string,
  terms: string,
  fetcher: TextFetcher,
  options: { now?: Date; check?: boolean; template?: string } = {},
): Promise<Loaded> {
  const template = options.template ?? (await searchTemplate(backend, root, fetcher));
  if (!template) throw new Error('This catalog doesn’t offer search.');
  const url = fillTemplate(template, terms);
  try {
    return await loadFeed(backend, url, fetcher, options);
  } catch (e) {
    // A static catalog has pages only for the terms it knows: none for this one means nothing found.
    if (e instanceof FeedError && e.status === 404) return { cached: emptyResults(url, terms) };
    if (e instanceof FeedError) throw e;
    if (options.template) throw e;
    const own = onHost(template.replace(/[{}]/g, (b) => (b === '{' ? '%7B' : '%7D')), root);
    if (!own) throw e;
    const ownTemplate = own.replace(/%7B/gi, '{').replace(/%7D/gi, '}');
    const loaded = await loadFeed(backend, fillTemplate(ownTemplate, terms), fetcher, options);
    const rootCached = await readCachedFeed(backend, root);
    if (rootCached) await writeCachedFeed(backend, { ...rootCached, searchTemplate: ownTemplate });
    return loaded;
  }
}

/** No results, as a page. */
const emptyResults = (url: string, terms: string): CachedFeed => {
  const now = new Date().toISOString();
  return { url, feed: { url, title: `Search: ${terms}`, entries: [], sections: [] }, digest: '', fetchedAt: now, checkedAt: now };
};

/** Where a search's results are cached, for the breadcrumbs and Load more. */
export const searchUrl = async (backend: LibraryBackend, root: string, terms: string) => {
  const template = (await readCachedFeed(backend, root))?.searchTemplate;
  return template ? fillTemplate(template, terms) : undefined;
};
