import type { Item, SortKey } from '@nexlibris/common';
import { t } from '../i18n';

export type BuiltinColumn =
  | 'cover'
  | 'creators'
  | 'titleSort'
  | 'authorSort'
  | 'series'
  | 'tags'
  | 'rating'
  | 'formats'
  | 'size'
  | 'added'
  | 'updated';
/** A built-in column, or `field:<key>` for a metadata field. */
export type ColumnId = BuiltinColumn | `field:${string}`;

export const BUILTIN_COLUMNS: { id: BuiltinColumn; label: string; sort?: SortKey }[] = [
  { id: 'cover', label: t('columns.cover') },
  { id: 'creators', label: t('columns.creators'), sort: 'author' },
  // What title and author sort by: the stored sort fields, else the forms worked out from the title and names.
  { id: 'titleSort', label: t('columns.titleSort'), sort: 'title' },
  { id: 'authorSort', label: t('columns.authorSort'), sort: 'author' },
  { id: 'series', label: t('columns.series'), sort: 'series' },
  { id: 'tags', label: t('columns.tags') },
  { id: 'rating', label: t('columns.rating'), sort: 'rating' },
  { id: 'formats', label: t('columns.formats') },
  // As Calibre's: the largest file's size.
  { id: 'size', label: t('columns.size'), sort: 'size' },
  { id: 'added', label: t('columns.added'), sort: 'added' },
  { id: 'updated', label: t('columns.updated') },
];

export const DEFAULT_COLUMNS: ColumnId[] = ['cover', 'creators', 'series', 'tags', 'rating', 'formats', 'added'];

/** Shown by their built-in columns, so not offered as field columns. */
const COVERED_FIELDS = new Set(['series', 'seriesIndex', 'titleSort', 'authorSort']);

export const fieldColumn = (key: string): ColumnId => `field:${key}`;
export const fieldKey = (id: ColumnId): string | undefined => (id.startsWith('field:') ? id.slice(6) : undefined);

/** Metadata fields used anywhere in the library that can be shown as columns, alphabetically. */
export function availableFields(items: Item[]): string[] {
  const keys = new Set<string>();
  for (const item of items) for (const key of Object.keys(item.metadata)) if (!COVERED_FIELDS.has(key)) keys.add(key);
  return [...keys].sort((a, b) => a.localeCompare(b));
}

/**
 * The columns to show, in a stable order: built-ins first, then fields alphabetically.
 * Ignores ids that aren't columns (e.g. from an older saved setting).
 */
export function visibleColumns(selected: readonly string[], fields: readonly string[]): ColumnId[] {
  const chosen = new Set(selected);
  return [
    ...BUILTIN_COLUMNS.filter((c) => chosen.has(c.id)).map((c) => c.id),
    ...fields.map(fieldColumn).filter((id) => chosen.has(id)),
  ];
}
