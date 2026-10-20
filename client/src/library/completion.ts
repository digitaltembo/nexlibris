import type { Item } from '@nexlibris/common';

/**
 * Completing values typed into a field: one value (a creator's name, which may hold commas), or
 * tags typed as a comma-separated list, where the tag being typed is the text after the last comma
 * and picking a completion replaces it, ready for the next.
 */

const fold = (text: string) => text.normalize('NFD').replace(/\p{M}/gu, '').trim().toLowerCase();
const words = (text: string) => fold(text).match(/[\p{L}\p{N}]+/gu) ?? [];

/**
 * Every value of `field` in `items` (tags, or creators' names), most used first, counted together
 * whatever their case and shown as first spelled.
 */
export function valuesIn(items: Iterable<Item>, field: 'tag' | 'author'): string[] {
  const counts = new Map<string, { value: string; count: number }>();
  for (const item of items) {
    for (const value of field === 'tag' ? item.tags : item.creators.map((c) => c.name)) {
      if (!value.trim()) continue;
      const entry = counts.get(fold(value)) ?? { value, count: 0 };
      entry.count++;
      counts.set(fold(value), entry);
    }
  }
  return [...counts.values()].sort((a, b) => b.count - a.count || a.value.localeCompare(b.value)).map((e) => e.value);
}

/** Every tag in `items`, most used first. */
export const tagsIn = (items: Iterable<Item>) => valuesIn(items, 'tag');

/** Every creator's name in `items`, most used first. */
export const creatorsIn = (items: Iterable<Item>) => valuesIn(items, 'author');

/**
 * The values in `candidates` (in their order) that complete `typed`: those it starts, then those
 * with words it starts. Ones in `exclude` aren't offered, nor is one typed in full.
 */
export function completions(typed: string, candidates: string[], exclude: string[] = [], limit = 8): string[] {
  const want = fold(typed);
  if (!want) return [];
  const taken = new Set(exclude.map(fold));
  const offered = candidates.filter((value) => !taken.has(fold(value)) && fold(value) !== want);
  const wanted = words(want);
  const starting = offered.filter((value) => fold(value).startsWith(want));
  const within = offered.filter(
    (value) => !starting.includes(value) && wanted.length > 0 && wanted.every((w) => words(value).some((h) => h.startsWith(w))),
  );
  return [...starting, ...within].slice(0, limit);
}

/** Completions for the last tag of a comma-separated `text`, leaving out those typed before it. */
export function tagCompletions(text: string, candidates: string[], exclude: string[] = [], limit = 8): string[] {
  const parts = text.split(',');
  return completions(parts[parts.length - 1]!, candidates, [...parts.slice(0, -1), ...exclude], limit);
}

/** `text` with the tag being typed replaced by `tag`, and a comma after it for the next. */
export function completeTag(text: string, tag: string): string {
  const comma = text.lastIndexOf(',');
  return `${comma < 0 ? '' : `${text.slice(0, comma + 1)} `}${tag}, `;
}
