import type { BookMetadata, MetadataValue } from './types';

/**
 * Normalizing `BookMetadata` values: dates as the partial ISO dates it keeps, and numbers as
 * numbers. Used when reading files and when migrating libraries stored before the fields were fixed.
 */

const HALF_DAY = 12 * 60 * 60 * 1000;

/**
 * A date as `BookMetadata` keeps it: `YYYY`, `YYYY-MM` or `YYYY-MM-DD`. A timestamp becomes the day
 * nearest it, as Calibre stores a day as the local midnight it began, in UTC (so a book published
 * in Paris on 12 May is "2010-05-11T22:00:00+00:00"). "October 1, 1990" becomes 1990-10-01, and
 * "June 1990" 1990-06. Calibre's 0101-01-01 means no date. Anything else is kept as it was written.
 */
export function normalizeDate(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed || trimmed.startsWith('0101-')) return undefined;
  if (/^\d{4}(-\d{2}){0,2}$/.test(trimmed)) return trimmed;
  if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(trimmed)) {
    const time = Date.parse(trimmed);
    if (Number.isNaN(time)) return trimmed.slice(0, 10);
    // With no zone given it's a local time, so the date is as written.
    if (!/(Z|[+-]\d{2}:?\d{2})$/i.test(trimmed)) return trimmed.slice(0, 10);
    return new Date(time + HALF_DAY).toISOString().slice(0, 10);
  }
  const parsed = Date.parse(`${trimmed} UTC`);
  if (Number.isNaN(parsed) || !/\d{4}/.test(trimmed)) return trimmed;
  const iso = new Date(parsed).toISOString().slice(0, 10);
  // A month and year ("June 1990") parses to the 1st; keep it to the month.
  return /\b\d{1,2}\b/.test(trimmed.replace(/\d{4}/, '')) ? iso : iso.slice(0, 7);
}

/** Fields `BookMetadata` keeps as dates and as numbers. */
export const DATE_FIELDS = ['published', 'originallyPublished'] as const;
export const NUMBER_FIELDS = ['seriesIndex', 'pages'] as const;

/** One value as `BookMetadata` keeps it under `key`, or undefined to leave it out. */
export function normalizeValue(key: string, value: MetadataValue | undefined): MetadataValue | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if ((DATE_FIELDS as readonly string[]).includes(key)) return typeof value === 'string' ? normalizeDate(value) : value;
  if ((NUMBER_FIELDS as readonly string[]).includes(key) && typeof value === 'string') {
    const number = Number(value.trim());
    return value.trim() && Number.isFinite(number) ? number : value;
  }
  if (key === 'coverColor' && typeof value === 'string') return /^#[0-9a-f]{6}$/i.test(value) ? value.toLowerCase() : undefined;
  return value;
}

/** Metadata with each value normalized, and empty ones left out. */
export function normalizeMetadata(metadata: Record<string, MetadataValue | undefined>): BookMetadata {
  const result: BookMetadata = {};
  for (const [key, value] of Object.entries(metadata)) {
    const normalized = normalizeValue(key, value);
    if (normalized !== undefined) result[key] = normalized;
  }
  return result;
}

/** Words a title sort moves to the end, as Calibre does with English titles. */
const ARTICLES = /^(the|a|an)\s+(.+)$/i;

/** A title as it sorts: "The Left Hand of Darkness" as "Left Hand of Darkness, The". */
export function titleSortOf(title: string): string {
  const match = ARTICLES.exec(title.trim());
  return match ? `${match[2]}, ${match[1]}` : title.trim();
}

const SUFFIXES = /^(jr|sr|junior|senior|ii|iii|iv|phd|md)\.?$/i;

/**
 * A name as it sorts, as Calibre makes an author sort: "Frank Herbert" as "Herbert, Frank". A
 * surname's particle stays with it ("Ursula K. Le Guin" as "Le Guin, Ursula K."), a suffix stays at
 * the end ("Herbert, Frank, Jr."), and a name with a comma already, or of one word, is left as it is.
 */
export function nameSortOf(name: string): string {
  const trimmed = name.trim().replace(/\s+/g, ' ');
  if (!trimmed || trimmed.includes(',')) return trimmed;
  const words = trimmed.split(' ');
  const suffix = words.length > 2 && SUFFIXES.test(words.at(-1)!) ? words.pop() : undefined;
  if (words.length < 2) return trimmed;
  let start = words.length - 1;
  while (start > 1 && /^(le|la|de|del|della|di|da|du|van|von|der|den|ten|ter|st\.?|bin|ibn|al)$/i.test(words[start - 1]!)) start--;
  const surname = words.slice(start).join(' ');
  return `${surname}, ${words.slice(0, start).join(' ')}${suffix ? `, ${suffix}` : ''}`;
}

/** The author sort for several names, joined as Calibre joins them. */
export const authorSortOf = (names: string[]) => names.map(nameSortOf).filter(Boolean).join(' & ');
