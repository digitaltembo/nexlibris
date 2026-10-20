import { compareDates, DATE_FIELDS, dateYear, datePrecision, normalizeDate, type Item, type MetadataValue } from '@nexlibris/common';
import { authorSortKey, bookSize, firstPublished, titleSortKey } from './bookFields';

function flatten(value: MetadataValue | undefined): string {
  if (value === null || value === undefined) return '';
  if (Array.isArray(value)) return value.map(flatten).join(' ');
  if (typeof value === 'object') return Object.values(value).map(flatten).join(' ');
  return String(value);
}

/** Lowercase words without accents, each preceded by a space, so ` ${word}` finds words starting with `word`. */
function normalize(text: string): string {
  const words = text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  return words.map((w) => ` ${w}`).join('');
}

/** Operations replace an item rather than change it, so its text can be kept until it's replaced. */
const searchTextCache = new WeakMap<Item, string>();

function searchText(item: Item): string {
  let text = searchTextCache.get(item);
  if (text === undefined) searchTextCache.set(item, (text = itemText(item)));
  return text;
}

function itemText(item: Item): string {
  return normalize([
    item.title,
    ...item.creators.map((c) => c.name),
    ...item.tags,
    ...Object.values(item.identifiers),
    ...Object.values(item.metadata).map(flatten),
  ].join(' '));
}

export type SortKey = 'title' | 'author' | 'series' | 'published' | 'rating' | 'size' | 'added';

export interface Sort {
  key: SortKey;
  desc: boolean;
}

/** The direction a column sorts in when first chosen. */
export const DEFAULT_DESC: Record<SortKey, boolean> = { title: false, author: false, series: false, published: false, rating: true, size: true, added: true };

/*
 * Search syntax, in the style of Gmail's. Words match the start of words anywhere in an item
 * ("verne" finds Jules Verne but not "governess"); a quoted phrase matches words in that order.
 * `field:value` matches one field:
 *
 *   author:herbert   tag:"Science fiction"   series:dune   format:epub   publisher:ace   isbn:9780441172719
 *   tag:fantasy,"Science fiction" (either)   rating:4+   pages:<300   added:"last 30 days"   added:>=2026-09
 *   has:cover   has:file   -has:series (no series)   size:>2M (the largest file; bytes, or K, M, G)
 *
 * A leading `-` negates a term. Terms must all match, unless separated by `or`: `a b or c` is
 * (a and b) or c. Tags and formats match whole values; other fields match the start of words, as
 * plain words do. `>`, `>=`, `<`, `<=`, `=` and a trailing `+` (at least) compare numbers (rating,
 * pages) or dates (added, published: "2026-09" is September 2026); "last N days" (weeks, months,
 * years) is relative to now. Any metadata field can be named (`language:fr`, a custom
 * `mood:cosy`); a `word:` that names no field is searched for as words, so "Dune: Messiah" still
 * finds Dune Messiah. It's how everything searches: the search box (whose dialog completes field
 * names and values, `suggest.ts`), connections' catalogs, the books another instance keeps, categories.
 */

/** Context for a search: the reader's ratings (per user, so not on the item), and the time "last 30 days" counts from. */
export interface SearchContext {
  ratings?: Record<string, number>;
  now?: Date;
}

export type Term = WordsTerm | FieldTerm | { kind: 'or' };

export interface WordsTerm {
  kind: 'words';
  text: string;
  phrase: boolean;
  negate: boolean;
}

/** A `field:value` term. Values are alternatives, each perhaps with a comparison. */
export interface FieldTerm {
  kind: 'field';
  field: string;
  values: string[];
  negate: boolean;
}

/** Built-in fields, with the names they're also known by. `text` is words anywhere, as one term. */
const FIELD_ALIASES: Record<string, string> = {
  text: 'text',
  title: 'title',
  author: 'author',
  authors: 'author',
  creator: 'author',
  creators: 'author',
  by: 'author',
  tag: 'tag',
  tags: 'tag',
  series: 'series',
  format: 'format',
  formats: 'format',
  rating: 'rating',
  added: 'added',
  updated: 'updated',
  size: 'size',
  isbn: 'isbn',
  identifier: 'identifier',
  has: 'has',
};

/** Fields matched as whole values rather than by words. */
const EXACT_FIELDS = new Set(['tag', 'format']);

/** `field:none` is the older spelling of `-has:field`. */
const NONE = 'none';

const COMPARISON = /^(>=|<=|>|<|=)/;
const RELATIVE = /^last\s+(?:(\d+)\s+)?(day|week|month|year)s?$/i;

/** Splits a query into terms. `fields` are the metadata keys that count as fields besides the built-in ones. */
export function parseQuery(query: string, fields: ReadonlySet<string> = new Set()): Term[] {
  const terms: Term[] = [];
  let pos = 0;
  const space = (i: number) => i >= query.length || /\s/.test(query[i]!);
  const readQuoted = () => {
    let value = '';
    pos++; // the opening quote
    while (pos < query.length && query[pos] !== '"') {
      if (query[pos] === '\\' && pos + 1 < query.length) pos++;
      value += query[pos++];
    }
    pos++; // the closing quote, if there is one
    return value;
  };

  while (pos < query.length) {
    if (space(pos)) {
      pos++;
      continue;
    }
    const start = pos;
    const negate = query[pos] === '-' && !space(pos + 1);
    if (negate) pos++;

    if (query[pos] === '"') {
      const text = readQuoted();
      if (text.trim()) terms.push({ kind: 'words', text, phrase: true, negate });
      continue;
    }

    const key = /^([\p{L}\p{N}_.#-]+):(?=\S)/u.exec(query.slice(pos));
    const field = key && (FIELD_ALIASES[key[1]!.toLowerCase()] ?? (fields.has(key[1]!) ? key[1]! : undefined));
    if (key && field) {
      pos += key[0].length;
      const values: string[] = [];
      for (;;) {
        if (query[pos] === '"') {
          values.push(readQuoted());
        } else {
          let value = '';
          while (!space(pos) && query[pos] !== '|' && query[pos] !== ',') value += query[pos++];
          values.push(value);
        }
        if (query[pos] !== '|' && query[pos] !== ',') break;
        pos++;
      }
      const kept = values.map((v) => v.trim()).filter(Boolean);
      if (kept.length) terms.push({ kind: 'field', field, values: kept, negate });
      continue;
    }

    while (!space(pos)) pos++;
    const text = query.slice(start + (negate ? 1 : 0), pos);
    if (!negate && /^or$/i.test(text)) terms.push({ kind: 'or' });
    else if (normalize(text)) terms.push({ kind: 'words', text, phrase: false, negate });
  }
  return terms;
}

const quote = (value: string) => (/^[^\s",|]+$/.test(value) ? value : `"${value.replace(/["\\]/g, '\\$&')}"`);

/** A term as query text; `parseQuery` reads it back as the same term. */
export function formatTerm(term: Term): string {
  if (term.kind === 'or') return 'or';
  const sign = term.negate ? '-' : '';
  if (term.kind === 'words') return sign + (term.phrase ? quote(term.text) : term.text);
  return `${sign}${term.field}:${term.values.map(quote).join(',')}`;
}

export const formatQuery = (terms: Term[]) => terms.map(formatTerm).join(' ');

/** Metadata keys in use, which can be searched as fields. */
export function metadataKeys(items: Iterable<Item>): Set<string> {
  const keys = new Set<string>();
  for (const item of items) for (const key of Object.keys(item.metadata)) keys.add(key);
  return keys;
}

/** An item's values for a field: strings to match as text, or numbers to compare. */
function fieldValues(item: Item, field: string, context: SearchContext): (string | number)[] {
  switch (field) {
    case 'title':
      return [item.title];
    case 'author':
      return item.creators.map((c) => c.name);
    case 'tag':
      return item.tags;
    case 'format':
    case 'file':
      return item.files.map((f) => f.format);
    case 'cover':
      return item.cover ? [item.cover.hash] : [];
    case 'rating': {
      const rating = context.ratings?.[item.id];
      return rating === undefined ? [] : [rating];
    }
    case 'size':
      return item.files.length ? [bookSize(item)] : [];
    case 'added':
      return [item.addedAt];
    case 'updated':
      return [item.updatedAt];
    case 'isbn':
      return Object.entries(item.identifiers).flatMap(([k, v]) => (k.startsWith('isbn') ? [v.replace(/[\s-]/g, '')] : []));
    case 'identifier':
      return Object.values(item.identifiers);
    default: {
      const value = item.metadata[field];
      if (value === undefined || value === null || value === '') return [];
      return typeof value === 'number' ? [value] : [flatten(value)];
    }
  }
}

/** The ISO date "last N units" starts from. */
function relativeStart(match: RegExpExecArray, now: Date): string {
  const n = Number(match[1] ?? 1);
  const date = new Date(now);
  const unit = match[2]!.toLowerCase();
  if (unit === 'day') date.setUTCDate(date.getUTCDate() - n);
  else if (unit === 'week') date.setUTCDate(date.getUTCDate() - 7 * n);
  else if (unit === 'month') date.setUTCMonth(date.getUTCMonth() - n);
  else date.setUTCFullYear(date.getUTCFullYear() - n);
  return date.toISOString();
}

function matchesValue(field: string, values: (string | number)[], wanted: string, context: SearchContext): boolean {
  if (wanted.toLowerCase() === NONE) return values.length === 0;
  const relative = RELATIVE.exec(wanted);
  if (relative) wanted = `>=${relativeStart(relative, context.now ?? new Date())}`;
  let op = COMPARISON.exec(wanted)?.[1];
  let target = op ? wanted.slice(op.length).trim() : wanted;
  if (!op && /^\d+(\.\d+)?\+$/.test(target)) {
    op = '>=';
    target = target.slice(0, -1);
  }
  // Sizes are in bytes, as in Calibre, with K, M or G (or KB, MB, GB) for more: size:>2M.
  const unit = field === 'size' ? SIZE_UNIT.exec(target) : null;
  if (unit) target = String(Number(unit[1]) * 1024 ** ' kmg'.indexOf(unit[2]!.toLowerCase()));
  const number = target !== '' && !Number.isNaN(Number(target)) ? Number(target) : undefined;
  // Dates compare on as much as was given, BC before AD: originallyPublished:<-500 is before 500 BC.
  const date = op && (DATE_FIELDS as readonly string[]).includes(field) ? normalizeDate(target) : undefined;
  if (date !== undefined && dateYear(date) !== undefined) {
    return values.some((value) => typeof value === 'string' && dateYear(value) !== undefined && compare(compareDates(value, date, datePrecision(date)), op!));
  }
  return values.some((value) => {
    if (typeof value === 'number' || (op && number !== undefined && !Number.isNaN(Number(value)))) {
      if (number === undefined) return false;
      return compare(Number(value) - number, op ?? '=');
    }
    // Dates and other text compare on as much as was given: added:>=2026-09 is from September 2026.
    if (op) return compare(value.slice(0, target.length).localeCompare(target), op);
    const have = normalize(value);
    const want = normalize(target);
    if (field === 'text') return want.split(' ').filter(Boolean).every((w) => have.includes(` ${w}`));
    return EXACT_FIELDS.has(field) ? have === want : have.includes(want);
  });
}

const SIZE_UNIT = /^(\d+(?:\.\d+)?)\s*([kmg])b?$/i;

function compare(difference: number, op: string): boolean {
  switch (op) {
    case '>':
      return difference > 0;
    case '>=':
      return difference >= 0;
    case '<':
      return difference < 0;
    case '<=':
      return difference <= 0;
    default:
      return difference === 0;
  }
}

function matches(item: Item, term: WordsTerm | FieldTerm, context: SearchContext): boolean {
  let found: boolean;
  if (term.kind === 'field' && term.field === 'has') {
    found = term.values.some((field) => fieldValues(item, FIELD_ALIASES[field.toLowerCase()] ?? field, context).length > 0);
  } else if (term.kind === 'field') {
    const values = term.field === 'text' ? [searchText(item)] : fieldValues(item, term.field, context);
    found = term.values.some((wanted) => matchesValue(term.field, values, wanted, context));
  } else {
    const text = searchText(item);
    const words = normalize(term.text);
    found = term.phrase ? text.includes(words) : words.split(' ').filter(Boolean).every((w) => text.includes(` ${w}`));
  }
  return found !== term.negate;
}

/** Terms grouped by `or`: an item matches if it matches every term of some group. */
export function orGroups(terms: Term[]): (WordsTerm | FieldTerm)[][] {
  const groups: (WordsTerm | FieldTerm)[][] = [[]];
  for (const term of terms) {
    if (term.kind === 'or') groups.push([]);
    else groups.at(-1)!.push(term);
  }
  return groups.filter((g) => g.length);
}

/** Items matching `query` (see the syntax above). */
export function filterItems(items: Item[], query: string, context: SearchContext = {}): Item[] {
  if (!query.trim()) return items;
  const groups = orGroups(parseQuery(query, query.includes(':') ? metadataKeys(items) : undefined));
  if (!groups.length) return items;
  return items.filter((item) => groups.some((group) => group.every((term) => matches(item, term, context))));
}

const text = (item: Item, key: string) => (typeof item.metadata[key] === 'string' ? (item.metadata[key] as string) : '');
const num = (item: Item, key: string) => (typeof item.metadata[key] === 'number' ? (item.metadata[key] as number) : 0);
const byTitle = (a: Item, b: Item) => titleSortKey(a).localeCompare(titleSortKey(b), undefined, { numeric: true });

/**
 * Sorts by `sort`, with title as the tiebreaker. Titles and authors sort by their sort forms
 * ("Left Hand of Darkness, The", "Le Guin, Ursula K."), and publication by when the work was first
 * published. Items missing the sort value (no series, no rating) go last in either direction.
 */
export function sortItems(items: Item[], sort: Sort, ratings: Record<string, number> = {}): Item[] {
  const dir = sort.desc ? -1 : 1;
  const compare: Record<SortKey, (a: Item, b: Item) => number> = {
    title: (a, b) => dir * byTitle(a, b),
    author: (a, b) => dir * authorSortKey(a).localeCompare(authorSortKey(b)) || byTitle(a, b),
    series: (a, b) => dir * (text(a, 'series').localeCompare(text(b, 'series')) || num(a, 'seriesIndex') - num(b, 'seriesIndex')),
    published: (a, b) => dir * compareDates(firstPublished(a), firstPublished(b)) || byTitle(a, b),
    rating: (a, b) => dir * ((ratings[a.id] ?? 0) - (ratings[b.id] ?? 0)) || byTitle(a, b),
    size: (a, b) => dir * (bookSize(a) - bookSize(b)) || byTitle(a, b),
    added: (a, b) => dir * a.addedAt.localeCompare(b.addedAt) || byTitle(a, b),
  };
  const missing = (item: Item) =>
    (sort.key === 'series' && !text(item, 'series')) || (sort.key === 'rating' && ratings[item.id] === undefined) ||
    (sort.key === 'author' && !item.creators.length) || (sort.key === 'published' && !firstPublished(item)) ||
    (sort.key === 'size' && !item.files.length);
  return [...items].sort((a, b) => Number(missing(a)) - Number(missing(b)) || compare[sort.key](a, b) || byTitle(a, b));
}
