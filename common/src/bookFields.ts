import { authorSortOf, DATE_FIELDS, formatDate, titleSortOf } from './metadata';
import type { BookMetadata, Item, MetadataValue } from './types';
import { metadataToText } from './metadataText';

/**
 * `BookMetadata`'s fixed fields as the UI shows them: labelled, in the order they're shown and
 * edited. The description has its own place, so isn't here. Any other metadata key is a custom
 * field, labelled from its name.
 */

export type BookFieldKind = 'text' | 'date' | 'number' | 'color';

export interface BookField {
  key: keyof BookMetadata & string;
  label: string;
  kind: BookFieldKind;
  /** Shown as the input's placeholder. */
  hint?: string;
}

const DATE_HINT = 'YYYY, YYYY-MM, YYYY-MM-DD or 570 BC';

export const BOOK_FIELDS: BookField[] = [
  { key: 'subtitle', label: 'Subtitle', kind: 'text' },
  { key: 'series', label: 'Series', kind: 'text' },
  { key: 'seriesIndex', label: 'Number in series', kind: 'number', hint: '1, 2.5…' },
  { key: 'originallyPublished', label: 'First published', kind: 'date', hint: DATE_HINT },
  { key: 'published', label: 'Edition published', kind: 'date', hint: DATE_HINT },
  { key: 'publisher', label: 'Publisher', kind: 'text' },
  { key: 'language', label: 'Language', kind: 'text', hint: 'en, fr, pt-BR…' },
  { key: 'pages', label: 'Pages', kind: 'number' },
  { key: 'rights', label: 'Rights', kind: 'text' },
  { key: 'titleSort', label: 'Title sort', kind: 'text' },
  { key: 'authorSort', label: 'Author sort', kind: 'text' },
  { key: 'coverColor', label: 'Cover colour', kind: 'color', hint: '#rrggbb' },
];

const FIXED = new Map(BOOK_FIELDS.map((f) => [f.key, f]));

export const bookField = (key: string): BookField | undefined => FIXED.get(key as BookField['key']);
export const isFixedField = (key: string) => FIXED.has(key as BookField['key']);

/** A field's label: the fixed fields' own, else its key in words ("readingOrder" as "Reading order"). */
export function fieldLabel(key: string): string {
  const fixed = bookField(key)?.label;
  if (fixed) return fixed;
  const words = key.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

const isDateField = (key: string) => (DATE_FIELDS as readonly string[]).includes(key);

/** A field's value as text, shown and edited: dates with their era where it's needed ("570 BC"). */
export function fieldText(key: string, value: MetadataValue | undefined): string {
  return isDateField(key) && typeof value === 'string' ? formatDate(value) : metadataToText(value);
}

/** How the title sorts: its title sort, else the title with any leading article moved to the end. */
export const titleSortKey = (item: Item) => item.metadata.titleSort || titleSortOf(item.title);

/** How the authors sort: the author sort, else the authors' names surname first. */
export function authorSortKey(item: Item): string {
  if (item.metadata.authorSort) return item.metadata.authorSort;
  const authors = item.creators.filter((c) => c.role === 'aut');
  return authorSortOf((authors.length ? authors : item.creators).map((c) => c.name));
}

/** When the work was first published, as far as the library knows: the original date, else this edition's. */
export const firstPublished = (item: Item) => item.metadata.originallyPublished || item.metadata.published || '';

/** A book's size as Calibre gives it: its largest file's, in bytes (0 with no files). */
export const bookSize = (item: Item) => item.files.reduce((max, file) => Math.max(max, file.size), 0);

/** A size in MB as Calibre's Size column shows it: one decimal, and `<0.1` for a small file rather than 0.0. */
export function sizeInMB(bytes: number): string {
  const mb = (bytes / (1024 * 1024)).toFixed(1);
  return bytes > 0 && mb === '0.0' ? '<0.1' : mb;
}
