import type { Category, Item, ItemId } from '@nexlibris/common';
import { stepTitle } from '../catalogs/titles';
import { filterItems, type SearchContext, type Sort } from './search';

/**
 * Browsing the library by category, as calibre3opds's catalog navigation does: from the Library,
 * All books, Currently reading, Authors, Series, the user's own categories, and Tags, then on to the
 * books under each author, series, tag or category entry. A place is a path:
 *
 *   []                          the Library: the categories
 *   ['all']                     books
 *   ['reading']                 the books being read (`currentlyReading.ts`), latest first
 *   ['authors'] ['series'] ['tags']        an entry per author, series or tag
 *   ['authors', name] ['series', name] ['tags', tag]   books
 *   ['category', id]            a category's entries (or, with just one, its books)
 *   ['category', id, n]         the books of its nth entry
 *   ['source', id, ...steps]    a catalog the library browses (`catalogs/`): its start, then each page
 *                               opened from there (an address, or `search:<terms>`)
 *   ['connection', id]          the books on another connection that reads: a reader, a folder,
 *                               another instance (`components/ConnectionBrowser.tsx`)
 *
 * Everything is worked out from the books the search and filters leave, so the entries narrow
 * as they do. All books is where the app starts.
 */

export type BrowsePath = string[];

export const ALL_BOOKS: BrowsePath = ['all'];

export interface BrowseEntry {
  label: string;
  /** E.g. "12 books", "34 authors". */
  detail: string;
  path: BrowsePath;
  /** A book whose cover stands for the entry. */
  sample?: Item;
}

export type BrowseView =
  | { kind: 'entries'; entries: BrowseEntry[]; noun: string; nouns: string }
  | {
      kind: 'books';
      items: Item[];
      /** The order these books have by nature (series order), else the user's. */
      sort?: Sort;
      /** In an order of their own that no sort gives (Currently reading: last read first), kept unless the user sorts. */
      ordered?: boolean;
    }
  /** A page of a catalog the library browses: its start, or `step` (`catalogs/titles.ts`). */
  | { kind: 'source'; id: string; step?: string }
  /** The books on a connection that reads, other than a catalog on a server. */
  | { kind: 'connection'; id: string }
  /** A place that no longer exists, such as a removed category. */
  | { kind: 'missing' };

/** A catalog the library browses, as the Library lists it. */
export interface SourceRef {
  id: string;
  name: string;
}

/** What the Library shows besides the books' own groupings. */
export interface BrowseExtras {
  /** Catalogs the library browses, listed last. */
  sources?: SourceRef[];
  /** Other connections that read (readers, folders, instances), listed after them. */
  connections?: (SourceRef & { label: string })[];
  /** The books being read, latest first (`library/currentlyReading.ts`). */
  reading?: ItemId[];
}

export interface Crumb {
  label: string;
  path: BrowsePath;
}

const byLabel = (a: string, b: string) => a.localeCompare(b, undefined, { sensitivity: 'base' });
const plural = (n: number, noun: string, nouns = `${noun}s`) => `${n} ${n === 1 ? noun : nouns}`;
const books = (n: number) => plural(n, 'book');
const seriesOf = (item: Item) => (typeof item.metadata.series === 'string' ? item.metadata.series.trim() : '');
const tagKey = (tag: string) => tag.trim().toLowerCase();
/** Its authors, else whoever made it (as the OPDS catalog has them). */
const authorsOf = (item: Item) => {
  const authors = item.creators.filter((c) => c.role === 'aut');
  return [...new Set((authors.length ? authors : item.creators).map((c) => c.name.trim()).filter(Boolean))];
};
const tagsOf = (item: Item) => [...new Set(item.tags.map(tagKey).filter(Boolean))];

/** Of these books, those being read, in the order given. */
function readingOf(items: Item[], reading: ItemId[]): Item[] {
  const byId = new Map(items.map((item) => [item.id, item]));
  return reading.flatMap((id) => byId.get(id) ?? []);
}

const SERIES_SORT: Sort = { key: 'series', desc: false };

/** Books grouped by a key (each book under every key it has), with each group's label. */
function groups(items: Item[], keys: (item: Item) => string[], label: (key: string, items: Item[]) => string) {
  const byKey = new Map<string, Item[]>();
  for (const item of items) {
    for (const key of keys(item)) {
      const group = byKey.get(key);
      if (group) group.push(item);
      else byKey.set(key, [item]);
    }
  }
  return [...byKey].map(([key, members]) => ({ key, label: label(key, members), items: members }));
}

/** How a tag is spelled most often among these books (tags match ignoring case). */
function tagLabel(key: string, items: Item[]): string {
  const counts = new Map<string, number>();
  for (const item of items) for (const tag of item.tags) if (tagKey(tag) === key) counts.set(tag.trim(), (counts.get(tag.trim()) ?? 0) + 1);
  // Ties go to the spelling that sorts first by code point, so capitals ("Science Fiction") win.
  return [...counts].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0]?.[0] ?? key;
}

/** FNV-1a: a quick, well-spread 32-bit hash. */
function hash(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
  return h >>> 0;
}

/**
 * Picks the books whose covers stand for a level's entries. Not simply the first by title, which
 * puts the same book ("1Q84") on every entry it's in: a book with a cover, one no earlier entry
 * shows if there is one, chosen by a hash of the entry and the book, so each entry keeps its
 * cover from one visit to the next and adding a book seldom changes it.
 */
function samples() {
  const shown = new Set<Item>();
  return (items: Item[], path: BrowsePath): Item | undefined => {
    const covered = items.filter((item) => item.cover);
    const pool = covered.length ? covered : items;
    const fresh = pool.filter((item) => !shown.has(item));
    const seed = path.join('/');
    let best: Item | undefined;
    let bestHash = -1;
    for (const item of fresh.length ? fresh : pool) {
      const h = hash(`${seed}\n${item.id}`);
      if (h > bestHash) [best, bestHash] = [item, h];
    }
    if (best) shown.add(best);
    return best;
  };
}

interface Grouping {
  label: string;
  noun: string;
  nouns: string;
  sort?: Sort;
  group(items: Item[]): { key: string; label: string; items: Item[] }[];
}

const GROUPINGS: Record<'authors' | 'series' | 'tags', Grouping> = {
  authors: { label: 'Authors', noun: 'author', nouns: 'authors', group: (items) => groups(items, authorsOf, (key) => key) },
  series: {
    label: 'Series',
    noun: 'series',
    nouns: 'series',
    sort: SERIES_SORT,
    group: (items) => groups(items, (item) => (seriesOf(item) ? [seriesOf(item)] : []), (key) => key),
  },
  tags: { label: 'Tags', noun: 'tag', nouns: 'tags', group: (items) => groups(items, tagsOf, tagLabel) },
};


const entryLabel = (category: Category, index: number) => {
  const entry = category.entries[index]!;
  return entry.label || entry.query;
};

/** What's at `path`: entries to go on to, or books. `items` are the books the search and filters leave. */
export function browse(
  items: Item[],
  path: BrowsePath,
  categories: Category[],
  context: SearchContext = {},
  { sources = [], connections = [], reading = [] }: BrowseExtras = {},
): BrowseView {
  const [kind, key, sub] = path;
  if (kind === 'connection') {
    if (!connections.some((c) => c.id === key) || path.length > 2) return { kind: 'missing' };
    return { kind: 'connection', id: key! };
  }
  if (kind === 'source') {
    if (!sources.some((s) => s.id === key)) return { kind: 'missing' };
    const step = path.at(-1);
    return { kind: 'source', id: key!, ...(path.length > 2 && step && { step }) };
  }
  if (kind === undefined) {
    const sampleOf = samples();
    const grouped = (name: keyof typeof GROUPINGS): BrowseEntry => {
      const found = GROUPINGS[name].group(items);
      return { label: GROUPINGS[name].label, detail: plural(found.length, GROUPINGS[name].noun, GROUPINGS[name].nouns), path: [name], sample: sampleOf(found.flatMap((g) => g.items), [name]) };
    };
    const custom = [...categories]
      .sort((a, b) => byLabel(a.name, b.name))
      .map((category): BrowseEntry => {
        const matched = [...new Set(category.entries.flatMap((e) => filterItems(items, e.query, context)))];
        const detail = category.entries.length === 1 ? books(matched.length) : plural(category.entries.length, 'entry', 'entries');
        return { label: category.name, detail, path: ['category', category.id], sample: sampleOf(matched, ['category', category.id]) };
      });
    return {
      kind: 'entries',
      noun: 'category',
      nouns: 'categories',
      entries: [
        { label: 'All books', detail: books(items.length), path: ALL_BOOKS, sample: sampleOf(items, ALL_BOOKS) },
        { label: 'Currently reading', detail: books(readingOf(items, reading).length), path: ['reading'], sample: readingOf(items, reading)[0] },
        grouped('authors'),
        grouped('series'),
        ...custom,
        grouped('tags'),
        ...sources.map((source): BrowseEntry => ({ label: source.name, detail: 'Catalog', path: ['source', source.id] })),
        ...connections.map((c): BrowseEntry => ({ label: c.name, detail: c.label, path: ['connection', c.id] })),
      ],
    };
  }
  if (kind === 'all' && key === undefined) return { kind: 'books', items };
  if (kind === 'reading' && key === undefined) return { kind: 'books', items: readingOf(items, reading), ordered: true };
  if (kind === 'authors' || kind === 'series' || kind === 'tags') {
    const grouping = GROUPINGS[kind];
    const found = grouping.group(items);
    if (key === undefined) {
      const sampleOf = samples();
      return {
        kind: 'entries',
        noun: grouping.noun,
        nouns: grouping.nouns,
        entries: found
          .sort((a, b) => byLabel(a.label, b.label))
          .map((g) => ({ label: g.label, detail: books(g.items.length), path: [kind, g.key], sample: sampleOf(g.items, [kind, g.key]) })),
      };
    }
    if (sub !== undefined) return { kind: 'missing' };
    // A group the search leaves no books in is still a place: it just shows none.
    return { kind: 'books', items: found.find((g) => g.key === key)?.items ?? [], ...(grouping.sort && { sort: grouping.sort }) };
  }
  if (kind === 'category' && key !== undefined) {
    const category = categories.find((c) => c.id === key);
    if (!category) return { kind: 'missing' };
    const entryBooks = (index: number) => filterItems(items, category.entries[index]!.query, context);
    if (sub === undefined && category.entries.length !== 1) {
      const sampleOf = samples();
      return {
        kind: 'entries',
        noun: 'entry',
        nouns: 'entries',
        entries: category.entries.map((_, index) => {
          const matched = entryBooks(index);
          const path = ['category', key, String(index)];
          return { label: entryLabel(category, index), detail: books(matched.length), path, sample: sampleOf(matched, path) };
        }),
      };
    }
    const index = sub === undefined ? 0 : Number(sub);
    if (!Number.isInteger(index) || !category.entries[index]) return { kind: 'missing' };
    return { kind: 'books', items: entryBooks(index) };
  }
  return { kind: 'missing' };
}

/** The way to `path`, from the Library, for the breadcrumbs. */
export function crumbs(items: Item[], path: BrowsePath, categories: Category[], sources: SourceRef[] = [], connections: SourceRef[] = []): Crumb[] {
  const trail: Crumb[] = [{ label: 'Library', path: [] }];
  const [kind, key, sub] = path;
  const add = (label: string, to: BrowsePath) => trail.push({ label, path: to });
  if (kind === 'all') add('All books', ALL_BOOKS);
  else if (kind === 'reading') add('Currently reading', ['reading']);
  else if (kind === 'authors' || kind === 'series' || kind === 'tags') {
    add(GROUPINGS[kind].label, [kind]);
    if (key !== undefined) {
      // Labelled from every book, so the crumb keeps its name while the search hides the books.
      const label = kind === 'tags' ? tagLabel(key, items) : key;
      add(label, [kind, key]);
    }
  } else if (kind === 'source') {
    const source = sources.find((s) => s.id === key);
    if (source) {
      add(source.name, ['source', source.id]);
      path.slice(2).forEach((step, i) => add(stepTitle(step), path.slice(0, 3 + i)));
    }
  } else if (kind === 'connection') {
    const connection = connections.find((c) => c.id === key);
    if (connection) add(connection.name, ['connection', connection.id]);
  } else if (kind === 'category' && key !== undefined) {
    const category = categories.find((c) => c.id === key);
    if (category) {
      add(category.name, ['category', key]);
      const index = Number(sub);
      if (sub !== undefined && category.entries[index]) add(entryLabel(category, index), ['category', key, sub]);
    }
  }
  return trail;
}

/** One level up from `path` (the Library is the top). */
export const parentPath = (path: BrowsePath): BrowsePath => path.slice(0, -1);

/** How many of what a view shows, e.g. "12 books" or "34 authors". */
export function viewCount(view: BrowseView): string | undefined {
  if (view.kind === 'books') return books(view.items.length);
  if (view.kind === 'entries') return plural(view.entries.length, view.noun, view.nouns);
  return undefined;
}
