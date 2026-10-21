/**
 * Books' metadata, as their files describe it and nexlibris's library keeps it, and normalizing its
 * values: dates as the partial ISO dates it keeps, and numbers as numbers. Used when reading files
 * and when migrating libraries stored before the fields were fixed.
 */

export interface Creator {
  name: string;
  /** MARC relator code, e.g. 'aut', 'edt', 'trl'. */
  role: string;
}

/** JSON-compatible value, used for arbitrary item metadata. */
export type MetadataValue = string | number | boolean | null | MetadataValue[] | { [key: string]: MetadataValue };

/**
 * An item's descriptive metadata beyond its title, creators, tags and identifiers (the item's own
 * fields, which operations change one at a time). The fields named here have fixed meanings and
 * shapes, covering what Calibre and EPUB's package metadata record; any other key is the user's
 * or a plugin's own (e.g. "mood", "x4:fontSize"). Values are normalized as below.
 * Typed since schema 4, which normalized the dates and numbers stored before. Part of a library's
 * stored shape: changing it means a migration in `@nexlibris/common` (`SCHEMA_VERSION`, `MIGRATIONS`).
 */
export interface BookMetadata {
  /** EPUB's `title-type="subtitle"`; the title doesn't repeat it. */
  subtitle?: string;
  /** How the title sorts, e.g. "Left Hand of Darkness, The" (Calibre's title sort, EPUB's title `file-as`). */
  titleSort?: string;
  /** How the authors sort, e.g. "Le Guin, Ursula K." (Calibre's author sort; EPUB's creator `file-as`, joined with " & "). */
  authorSort?: string;
  series?: string;
  /** The book's place in its series; may be fractional (2.5). */
  seriesIndex?: number;
  publisher?: string;
  /**
   * When this edition was published (EPUB's `dc:date`, Calibre's publication date), as `YYYY`,
   * `YYYY-MM` or `YYYY-MM-DD`. For an ebook this is often the ebook's own release.
   */
  published?: string;
  /** When the work itself was first published, which is what a library is usually sorted by; as `published`. */
  originallyPublished?: string;
  /** The book's main language, as a BCP 47 tag (e.g. "en", "pt-BR"). */
  language?: string;
  /** HTML, untrusted: shown with `RichText`. */
  description?: string;
  /** EPUB's `dc:rights`. */
  rights?: string;
  pages?: number;
  /** The cover's most prominent colour, as `#rrggbb`, for styling around the book. */
  coverColor?: string;
  [key: string]: MetadataValue | undefined;
}

const tagKey = (tag: string) => tag.trim().toLowerCase();

/** Appends trimmed tags not already present, comparing case-insensitively. */
export function mergeTags(existing: string[], added: string[]): string[] {
  const seen = new Set(existing.map(tagKey));
  const merged = [...existing];
  for (const tag of added) {
    const trimmed = tag.trim();
    if (!trimmed || seen.has(tagKey(trimmed))) continue;
    seen.add(tagKey(trimmed));
    merged.push(trimmed);
  }
  return merged;
}

const HALF_DAY = 12 * 60 * 60 * 1000;

/**
 * A date as `BookMetadata` keeps it: `YYYY`, `YYYY-MM` or `YYYY-MM-DD`, with a minus for a year
 * before AD 1, counted as historians do, with no year 0: `-0570` is 570 BC. A timestamp becomes the
 * day nearest it, as Calibre stores a day as the local midnight it began, in UTC (so a book
 * published in Paris on 12 May is "2010-05-11T22:00:00+00:00"). "October 1, 1990" becomes
 * 1990-10-01, "June 1990" 1990-06, "570 BC" (or BCE, or -570) -0570, and "AD 8" (8 CE, or 8) 0008.
 * Calibre's 0101-01-01 means no date. Anything else is kept as it was written.
 */
export function normalizeDate(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed || trimmed.startsWith('0101-')) return undefined;
  if (/^-?\d{4}(-\d{2}){0,2}$/.test(trimmed)) return trimmed === '0000' || trimmed === '-0000' ? undefined : trimmed;
  const era = ERA.exec(trimmed);
  if (era) {
    const year = Number(era[1] ?? era[3] ?? era[4]);
    const bc = !!era[2] || !!era[4];
    return year ? `${bc ? '-' : ''}${String(year).padStart(4, '0')}` : undefined;
  }
  if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(trimmed)) {
    const time = Date.parse(trimmed);
    if (Number.isNaN(time)) return trimmed.slice(0, 10);
    // With no zone given it's a local time, so the date is as written.
    if (!/(Z|[+-]\d{2}:?\d{2})$/i.test(trimmed)) return trimmed.slice(0, 10);
    return new Date(time + HALF_DAY).toISOString().slice(0, 10);
  }
  // A year of fewer digits is one AD (Date.parse would take "-570" as AD 570, so it doesn't see these).
  if (/^\d{1,3}$/.test(trimmed)) return Number(trimmed) ? trimmed.padStart(4, '0') : undefined;
  const parsed = trimmed.startsWith('-') ? Number.NaN : Date.parse(`${trimmed} UTC`);
  if (Number.isNaN(parsed) || !/\d{4}/.test(trimmed)) return trimmed;
  const iso = new Date(parsed).toISOString().slice(0, 10);
  // A month and year ("June 1990") parses to the 1st; keep it to the month.
  return /\b\d{1,2}\b/.test(trimmed.replace(/\d{4}/, '')) ? iso : iso.slice(0, 7);
}

/** A year with its era: "570 BC", "570 BCE", "c. 570 BC", "-570", "AD 8", "8 AD", "8 CE". */
const ERA = /^(?:c(?:a|irca)?\.?\s*)?(?:(\d{1,4})\s*(?:(B\.?\s?C\.?(?:E\.?)?)|A\.?\s?D\.?|C\.?\s?E\.?)|A\.?\s?D\.?\s*(\d{1,4})|-(\d{1,4}))$/i;

/** A stored date's year as a signed number (570 BC is -570), or undefined if it isn't a date. */
export function dateYear(value: string | undefined): number | undefined {
  const match = /^(-?)(\d{4})(?:-\d{2}){0,2}$/.exec(value ?? '');
  return match ? Number(match[2]) * (match[1] ? -1 : 1) : undefined;
}

/** A stored date for reading: "570 BC" for -0570, "AD 8" for 0008; others as they are. */
export function formatDate(value: string): string {
  const year = dateYear(value);
  if (year === undefined) return value;
  const rest = value.replace(/^-?\d{4}/, '');
  if (year < 0) return `${-year}${rest} BC`;
  return year < 1000 ? `AD ${year}${rest}` : value;
}

/** Just the year of a stored date for reading ("570 BC", "AD 8", "1965"), or '' if it has none. */
export function formatYear(value: string | undefined): string {
  const year = dateYear(value);
  if (year === undefined) return value?.slice(0, 4) ?? '';
  return year < 0 ? `${-year} BC` : year < 1000 ? `AD ${year}` : String(year);
}

/**
 * Orders stored dates: by year (BC before AD), then month and day. With `precision` (1 for the
 * year, 2 for the month, 3 for the day) only that much of each is compared, as a search does:
 * published:>=1990-06 takes in 1990-06-15. Values that aren't dates compare as text, after dates.
 */
export function compareDates(a: string, b: string, precision = 3): number {
  const ya = dateYear(a);
  const yb = dateYear(b);
  if (ya === undefined || yb === undefined) return ya !== undefined ? -1 : yb !== undefined ? 1 : a.localeCompare(b);
  if (ya !== yb) return ya - yb;
  const parts = (v: string) => v.replace(/^-?\d{4}-?/, '').split('-').filter(Boolean).slice(0, precision - 1);
  return parts(a).join('-').localeCompare(parts(b).join('-'));
}

/** How many parts a stored date has: 1 (year), 2 (month) or 3 (day). */
export const datePrecision = (value: string) => value.replace(/^-/, '').split('-').length;

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
