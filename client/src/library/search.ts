import type { Item, MetadataValue } from '@nexlibris/common';

function flatten(value: MetadataValue): string {
  if (value === null) return '';
  if (Array.isArray(value)) return value.map(flatten).join(' ');
  if (typeof value === 'object') return Object.values(value).map(flatten).join(' ');
  return String(value);
}

function searchText(item: Item): string {
  return [
    item.title,
    ...item.creators.map((c) => c.name),
    ...item.tags,
    ...Object.values(item.identifiers),
    ...Object.values(item.metadata).map(flatten),
  ]
    .join(' ')
    .toLowerCase();
}

export type SortKey = 'title' | 'author' | 'series' | 'rating' | 'added';

export interface Sort {
  key: SortKey;
  desc: boolean;
}

/** The direction a column sorts in when first chosen. */
export const DEFAULT_DESC: Record<SortKey, boolean> = { title: false, author: false, series: false, rating: true, added: true };

/** Items matching every word of `query` anywhere in their metadata. */
export function filterItems(items: Item[], query: string): Item[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  return words.length ? items.filter((item) => words.every((w) => searchText(item).includes(w))) : items;
}

const text = (item: Item, key: string) => (typeof item.metadata[key] === 'string' ? (item.metadata[key] as string) : '');
const num = (item: Item, key: string) => (typeof item.metadata[key] === 'number' ? (item.metadata[key] as number) : 0);
const byTitle = (a: Item, b: Item) => a.title.localeCompare(b.title, undefined, { numeric: true });

/**
 * Sorts by `sort`, with title as the tiebreaker. Items missing the sort value
 * (no series, no rating) go last in either direction.
 */
export function sortItems(items: Item[], sort: Sort, ratings: Record<string, number> = {}): Item[] {
  const dir = sort.desc ? -1 : 1;
  const firstAuthor = (item: Item) => item.creators[0]?.name ?? '';
  const compare: Record<SortKey, (a: Item, b: Item) => number> = {
    title: (a, b) => dir * byTitle(a, b),
    author: (a, b) => dir * firstAuthor(a).localeCompare(firstAuthor(b)) || byTitle(a, b),
    series: (a, b) => dir * (text(a, 'series').localeCompare(text(b, 'series')) || num(a, 'seriesIndex') - num(b, 'seriesIndex')),
    rating: (a, b) => dir * ((ratings[a.id] ?? 0) - (ratings[b.id] ?? 0)) || byTitle(a, b),
    added: (a, b) => dir * a.addedAt.localeCompare(b.addedAt) || byTitle(a, b),
  };
  const missing = (item: Item) =>
    (sort.key === 'series' && !text(item, 'series')) || (sort.key === 'rating' && ratings[item.id] === undefined) ||
    (sort.key === 'author' && !item.creators.length);
  return [...items].sort((a, b) => Number(missing(a)) - Number(missing(b)) || compare[sort.key](a, b) || byTitle(a, b));
}
