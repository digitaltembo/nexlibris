import { createItem, mergeTags, normalizeDate, type Creator, type Item, type LibraryBackend, type MetadataValue } from '@nexlibris/common';
import { coverColor } from '../library/coverColor';
import { isbn13to10 } from './isbn';
import { bcp47Language } from '../formats/language';

/**
 * Book lookup by ISBN from Open Library (https://openlibrary.org/developers/api), which
 * needs no API key and allows requests from any origin, so it runs in the client. One
 * request gets the edition's main details; the edition and work records add its language,
 * series and description when they can be had (older records name the series on the edition,
 * newer ones refer to a series record from the work).
 */

const ORIGIN = 'https://openlibrary.org';

export interface BookInfo {
  isbn: string;
  title: string;
  creators: Creator[];
  identifiers: Record<string, string>;
  tags: string[];
  metadata: Record<string, MetadataValue>;
  coverUrl?: string;
  /** The edition's page on Open Library. */
  url: string;
}

interface DataRecord {
  key?: string;
  url?: string;
  title?: string;
  subtitle?: string;
  authors?: { name?: string }[];
  publishers?: { name?: string }[];
  publish_date?: string;
  subjects?: { name?: string }[];
  number_of_pages?: number;
  identifiers?: Record<string, string[]>;
  cover?: { small?: string; medium?: string; large?: string };
}

interface EditionRecord {
  languages?: { key?: string }[];
  series?: string[];
  works?: { key?: string }[];
  description?: string | { value?: string };
}

interface WorkRecord {
  description?: string | { value?: string };
  /** When the work was first published, e.g. "1965" or "August 1965". */
  first_publish_date?: string;
  subjects?: string[];
  /** Newer records: a series by reference, with the work's place in it. */
  series?: { series?: { key?: string }; position?: string }[];
}

/** The book with this ISBN-13, or undefined if Open Library doesn't know it. Throws if Open Library can't be reached. */
export async function lookupIsbn(isbn: string, fetchFn: typeof fetch = (input, init) => fetch(input, init)): Promise<BookInfo | undefined> {
  const getJson = async <T,>(path: string): Promise<T> => {
    let response: Response;
    try {
      response = await fetchFn(`${ORIGIN}${path}`, { headers: { Accept: 'application/json' } });
    } catch (e) {
      throw new Error(`Couldn’t reach Open Library (${e instanceof Error ? e.message : String(e)}).`);
    }
    if (!response.ok) throw new Error(`Open Library answered ${response.status} ${response.statusText}`.trim());
    return (await response.json()) as T;
  };
  const optional = async <T,>(path: string | undefined): Promise<T | undefined> => {
    if (!path || !/^\/(books\/OL\d+M|works\/OL\d+W|series\/OL\d+L)$/.test(path)) return undefined;
    try {
      return await getJson<T>(`${path}.json`);
    } catch {
      return undefined;
    }
  };

  const found = await getJson<Record<string, DataRecord>>(`/api/books?bibkeys=ISBN:${isbn}&format=json&jscmd=data`);
  const data = found[`ISBN:${isbn}`];
  if (!data?.title) return undefined;
  const edition = await optional<EditionRecord>(data.key);
  const work = await optional<WorkRecord>(edition?.works?.[0]?.key);

  const metadata: Record<string, MetadataValue> = {};
  const set = (key: string, value: MetadataValue | undefined) => {
    if (value !== undefined && value !== '') metadata[key] = value;
  };
  set('publisher', data.publishers?.[0]?.name?.trim());
  set('published', publishedDate(data.publish_date));
  set('originallyPublished', publishedDate(work?.first_publish_date));
  set('pages', data.number_of_pages && data.number_of_pages > 0 ? data.number_of_pages : undefined);
  set('language', language(edition?.languages?.[0]?.key));
  set('description', text(work?.description) ?? text(edition?.description));
  let series = parseSeries(edition?.series?.[0]);
  const workSeries = work?.series?.[0];
  if (!series && workSeries?.series?.key) {
    const name = (await optional<{ name?: string }>(workSeries.series.key))?.name?.trim();
    const index = Number(workSeries.position);
    if (name) series = { name, ...(workSeries.position && !Number.isNaN(index) && { index }) };
  }
  set('series', series?.name);
  set('seriesIndex', series?.index);

  const identifiers: Record<string, string> = { isbn };
  const first = (key: string) => data.identifiers?.[key]?.find((v) => v.trim())?.trim();
  for (const [key, from] of [['openlibrary', 'openlibrary'], ['goodreads', 'goodreads'], ['librarything', 'librarything'], ['lccn', 'lccn'], ['oclc', 'oclc']] as const) {
    const value = first(from);
    if (value) identifiers[key] = value;
  }

  const title = data.subtitle ? `${data.title.trim()}: ${data.subtitle.trim()}` : data.title.trim();
  const authors = (data.authors ?? []).map((a) => a.name?.trim()).filter((name): name is string => !!name);
  return {
    isbn,
    title,
    creators: authors.map((name) => ({ name, role: 'aut' })),
    identifiers,
    tags: tagsFrom([...(data.subjects ?? []).map((s) => s.name ?? ''), ...(work?.subjects ?? [])]),
    metadata,
    ...(data.cover && { coverUrl: data.cover.large ?? data.cover.medium ?? data.cover.small }),
    url: data.url?.replace(/^http:/, 'https:') ?? `${ORIGIN}/isbn/${isbn13to10(isbn) ?? isbn}`,
  };
}

/** Downloads a cover; undefined if there isn't one to be had. */
export async function fetchCover(
  url: string,
  fetchFn: typeof fetch = (input, init) => fetch(input, init),
): Promise<{ data: Blob; mediaType: string } | undefined> {
  try {
    const response = await fetchFn(url);
    if (!response.ok) return undefined;
    const data = await response.blob();
    const mediaType = response.headers.get('content-type')?.split(';')[0]?.trim() || 'image/jpeg';
    // Open Library's placeholder for a missing cover is a 1×1 GIF of a few dozen bytes.
    if (!mediaType.startsWith('image/') || data.size < 1000) return undefined;
    return { data, mediaType };
  } catch {
    return undefined;
  }
}

/** A cover Open Library has for a book: `url` full size, `preview` small enough for a list of them. */
export interface CoverChoice {
  url: string;
  preview: string;
  /** What it's the cover of, e.g. "Dune, 1965" or "ISBN 9780441172719". */
  label: string;
}

interface SearchResult {
  docs?: { cover_i?: number; title?: string; first_publish_year?: number }[];
}

const COVERS = 'https://covers.openlibrary.org';
const coverById = (id: number, size: 'M' | 'L') => `${COVERS}/b/id/${id}-${size}.jpg`;

/**
 * Covers Open Library has for a book: its editions' by ISBN first, then those of the works a
 * search by title and author finds. Throws only if Open Library can't be reached at all.
 */
export async function findCovers(
  book: { isbns: string[]; title: string; authors: string[] },
  fetchFn: typeof fetch = (input, init) => fetch(input, init),
): Promise<CoverChoice[]> {
  const getJson = async <T,>(path: string): Promise<T> => {
    const response = await fetchFn(`${ORIGIN}${path}`, { headers: { Accept: 'application/json' } });
    if (!response.ok) throw new Error(`Open Library answered ${response.status} ${response.statusText}`.trim());
    return (await response.json()) as T;
  };
  const isbns = [...new Set(book.isbns.map((isbn) => isbn.replace(/[^0-9X]/gi, '')).filter(Boolean))];
  const byIsbn = async (): Promise<CoverChoice[]> => {
    const keys = isbns.map((isbn) => `ISBN:${isbn}`).join(',');
    const found = await getJson<Record<string, DataRecord>>(`/api/books?bibkeys=${keys}&format=json&jscmd=data`);
    return isbns.flatMap((isbn) => {
      const cover = found[`ISBN:${isbn}`]?.cover;
      const url = cover?.large ?? cover?.medium;
      return url ? [{ url, preview: cover?.medium ?? url, label: `ISBN ${isbn}` }] : [];
    });
  };
  const title = book.title.trim();
  const bySearch = async (): Promise<CoverChoice[]> => {
    const params = new URLSearchParams({ title, fields: 'cover_i,title,first_publish_year', limit: '20' });
    const author = book.authors.find((a) => a.trim());
    if (author) params.set('author', author.trim());
    const found = await getJson<SearchResult>(`/search.json?${params}`);
    return (found.docs ?? []).flatMap((doc) =>
      doc.cover_i && doc.cover_i > 0
        ? [{
            url: coverById(doc.cover_i, 'L'),
            preview: coverById(doc.cover_i, 'M'),
            label: [doc.title, doc.first_publish_year].filter(Boolean).join(', '),
          }]
        : [],
    );
  };

  const results = await Promise.allSettled([...(isbns.length ? [byIsbn()] : []), ...(title ? [bySearch()] : [])]);
  if (results.length && results.every((r) => r.status === 'rejected')) {
    const e = (results[0] as PromiseRejectedResult).reason;
    throw new Error(`Couldn’t reach Open Library (${e instanceof Error ? e.message : String(e)}).`);
  }
  // The same cover can come from an ISBN and a search, by URLs that differ only in size.
  const seen = new Set<string>();
  return results.flatMap((r) => (r.status === 'fulfilled' ? r.value : [])).filter((choice) => {
    const key = choice.url.replace(/-[SML]\.jpg$/, '').replace(/^http:/, 'https:');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** A new item for a looked-up book, with no file, and its cover stored. */
export async function itemFromBook(backend: LibraryBackend, book: BookInfo, fetchFn?: typeof fetch): Promise<Item> {
  const cover = book.coverUrl ? await fetchCover(book.coverUrl, fetchFn) : undefined;
  return createItem({
    title: book.title,
    creators: book.creators,
    identifiers: book.identifiers,
    tags: book.tags,
    metadata: { ...book.metadata, coverColor: cover && (await coverColor(cover.data)) },
    ...(cover && { cover: { hash: (await backend.putFile(cover.data)).hash, mediaType: cover.mediaType } }),
  });
}

const text = (value: string | { value?: string } | undefined) =>
  (typeof value === 'string' ? value : value?.value)?.trim() || undefined;

function language(key: string | undefined): string | undefined {
  const code = key?.split('/').pop();
  return code ? bcp47Language(code) : undefined;
}

/** "2020" and "1990-10-01" as they are; "October 1, 1990" as 1990-10-01; anything else as it is (see `normalizeDate`). */
export const publishedDate = normalizeDate;

/** "Dune chronicles -- bk. 1", "Discworld ; 12", "Foundation, #2": the name and its number. */
export function parseSeries(value: string | undefined): { name: string; index?: number } | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  const match = /^(.*?)[\s,;]*(?:--|;|,|\(|#|\b(?:bk|book|vol|volume|no|number|pt|part)\b\.?)\s*#?\s*(\d+(?:\.\d+)?)\)?\s*$/i.exec(trimmed);
  if (match && match[1]!.trim()) return { name: match[1]!.trim().replace(/[\s,;:-]+$/, ''), index: Number(match[2]) };
  return { name: trimmed };
}

/** Subjects worth keeping as tags: short, plain ones ("Science fiction"), not cataloguing detail or lists. */
export function tagsFrom(subjects: string[]): string[] {
  const NOISE = /^(accessible book|protected daisy|in library|lending library|large type books|overdrive|new york times|fiction, general)/i;
  const kept = subjects
    .map((s) => s.trim())
    .filter((s) => s && !/[:(),_=]/.test(s) && !NOISE.test(s) && s.split(/\s+/).length <= 3 && s.length <= 30);
  return mergeTags([], kept).slice(0, 8);
}
