import { authorSortKey, firstPublished, formatYear, type Item, titleSortKey } from '@nexlibris/common';

/**
 * Where a book goes on a device, as a path template: `/Books/<author>/<title>/`, with the file
 * named by a second template (`<title>[ - <author>]`). Placeholders are the book's details, made
 * safe for SD cards (FAT): characters it doesn't allow become spaces, and a part can't start with
 * a dot (CrossPoint hides those) or end with a dot or space.
 *
 * - `<field>`: a detail of the book (`PLACEHOLDERS`); case, spaces and hyphens don't matter, so
 *   `<author sort>` is `<authorSort>`.
 * - `<field:N>`: its first N characters, e.g. `<authorSort:1>` for a folder per letter.
 * - `[ … ]`: kept only if every placeholder in it has a value, e.g. `[<series>/]` for a folder
 *   only for books in a series, or `[<series> <seriesIndex> - ]<title>`.
 * - Folders left empty (a placeholder with no value) are left out.
 */

/** Books' file names unless a device says otherwise: `Dune - Frank Herbert`, or the title alone. */
export const DEFAULT_FILE_NAME = '<title>[ - <author>]';

export interface Placeholder {
  key: string;
  label: string;
  value(item: Item): string;
}

const authors = (item: Item) => {
  const named = item.creators.filter((c) => c.role === 'aut');
  return named.length ? named : item.creators;
};
const metadata = (item: Item, key: string) => {
  const value = item.metadata[key];
  return typeof value === 'string' || typeof value === 'number' ? String(value) : '';
};

export const PLACEHOLDERS: Placeholder[] = [
  { key: 'title', label: 'Title', value: (item) => item.title },
  { key: 'titleSort', label: 'Title sort', value: titleSortKey },
  { key: 'author', label: 'First author', value: (item) => authors(item)[0]?.name ?? '' },
  { key: 'authors', label: 'All authors, joined by “&”', value: (item) => authors(item).map((c) => c.name).join(' & ') },
  { key: 'authorSort', label: 'Author sort', value: authorSortKey },
  { key: 'series', label: 'Series', value: (item) => metadata(item, 'series') },
  { key: 'seriesIndex', label: 'Number in series', value: (item) => metadata(item, 'seriesIndex') },
  { key: 'year', label: 'Year first published', value: (item) => formatYear(firstPublished(item)) },
  { key: 'publisher', label: 'Publisher', value: (item) => metadata(item, 'publisher') },
  { key: 'language', label: 'Language', value: (item) => metadata(item, 'language') },
  { key: 'isbn', label: 'ISBN', value: (item) => item.identifiers.isbn ?? '' },
];

/** `<author sort>`, `<Author-Sort>` and `<authorsort>` are all `authorSort`. */
const normalize = (name: string) => name.replace(/[\s_-]+/g, '').toLowerCase();
const BY_NAME = new Map(PLACEHOLDERS.map((p) => [normalize(p.key), p]));

/** A placeholder, or an optional section; a section can't contain another. */
const TOKEN = /\[([^[\]]*)\]|<([^<>]*)>/g;
const PLACEHOLDER = /<([^<>]*)>/g;

function lookup(text: string): { placeholder?: Placeholder; length?: number } {
  const [name = '', count] = text.split(':');
  const placeholder = BY_NAME.get(normalize(name));
  const length = count === undefined ? undefined : Number(count.trim());
  return { ...(placeholder && { placeholder }), ...(length && length > 0 && { length }) };
}

/** What's wrong with a template, for showing as it's typed: unknown placeholders, unmatched brackets. */
export function templateProblems(template: string): string[] {
  const problems: string[] = [];
  for (const [, inside] of template.matchAll(PLACEHOLDER)) {
    const { placeholder } = lookup(inside!);
    if (!placeholder) problems.push(`<${inside}> isn’t a detail nexlibris knows.`);
  }
  const outside = template.replace(TOKEN, '');
  if (/[<>]/.test(outside)) problems.push('A < or > doesn’t pair up.');
  if (/[[\]]/.test(outside)) problems.push('A [ or ] doesn’t pair up (and sections can’t be nested).');
  return problems;
}

/** Characters FAT file systems (and so SD cards) don't allow, plus control characters. */
// oxlint-disable-next-line no-control-regex -- matching control characters is the point.
const UNSAFE = /[\\/:*?"<>|\u0000-\u001f]/g;

/** A detail as it goes into a path: no characters a file name can't have, slashes included. */
const safeValue = (text: string) => text.replace(UNSAFE, ' ');

/** One folder or file name: tidy spaces, no leading dot, no trailing dot or space, not too long. */
export function safeSegment(text: string, max = 80) {
  const tidy = (s: string) => s.replace(/\s+/g, ' ').trim().replace(/^\.+/, '').replace(/[. ]+$/, '');
  return tidy(tidy(text.replace(UNSAFE, ' ')).slice(0, max));
}

/** A template with the book's details put in, as path segments (empty ones left out). */
function segments(template: string, item: Item): string[] {
  const fill = (inside: string) => {
    const { placeholder, length } = lookup(inside);
    const value = placeholder ? safeValue(placeholder.value(item)).trim() : '';
    return length ? value.slice(0, length) : value;
  };
  const filled = template.replace(TOKEN, (_, section: string | undefined, inside: string | undefined) => {
    if (inside !== undefined) return fill(inside);
    const names = [...section!.matchAll(PLACEHOLDER)].map((m) => m[1]!);
    return names.every((name) => fill(name)) ? section!.replace(PLACEHOLDER, (__, name: string) => fill(name)) : '';
  });
  return filled.split('/').map((s) => safeSegment(s)).filter(Boolean);
}

/** The folder a template puts a book in: `/Books/Frank Herbert/Dune`. */
export const expandFolder = (template: string, item: Item) => `/${segments(template, item).join('/')}`;

/**
 * A book's path on the device: the folder template's folder, then the file template's name (any
 * folders in it too), ` (n)` for the nth book with that path, and the extension.
 */
export function expandPath(folderTemplate: string, fileTemplate: string, item: Item, extension: string, n = 1): string {
  const name = segments(fileTemplate.trim() || DEFAULT_FILE_NAME, item);
  const base = name.pop() || 'Untitled';
  return `/${[...segments(folderTemplate, item), ...name, n === 1 ? base : `${base} (${n})`].join('/')}.${extension}`;
}

/** The part of a folder template that's the same for every book: where to look for its books. */
export function templateRoot(template: string): string {
  const fixed: string[] = [];
  for (const segment of template.split('/')) {
    if (/[<[]/.test(segment)) break;
    const safe = safeSegment(segment);
    if (safe) fixed.push(safe);
  }
  return `/${fixed.join('/')}`;
}

/** Whether a template has anything to fill in, so books may each go in their own folder. */
export const hasPlaceholders = (template: string) => /[<[]/.test(template);
