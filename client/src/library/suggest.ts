import type { Item } from '@nexlibris/common';
import { fieldSuggestions, type FilterField } from './filters';
import { formatTerm } from './search';

/**
 * Completions for the search box: the word being typed (the one at the caret) becomes a field
 * term. A plain word suggests the authors, series and tags it starts, and the fields it names
 * ("aut" → `author:`); after `field:` come that field's values. Picking one replaces the word.
 */

export interface Suggestion {
  /** What's shown, e.g. "Frank Herbert". */
  label: string;
  /** What kind it is, e.g. "Author" or "Field". */
  kind: string;
  /** The query and caret once it's picked. */
  query: string;
  caret: number;
}

/** The word at `caret`: from the last space outside quotes before it to the next one after it. */
export function wordAt(query: string, caret: number): { start: number; end: number } {
  let start = 0;
  let quoted = false;
  for (let i = 0; i < caret; i++) {
    if (query[i] === '"') quoted = !quoted;
    else if (!quoted && /\s/.test(query[i]!)) start = i + 1;
  }
  let end = caret;
  for (; end < query.length; end++) {
    if (query[end] === '"') quoted = !quoted;
    else if (!quoted && /\s/.test(query[end]!)) break;
  }
  return { start, end };
}

const fold = (text: string) => text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
const words = (text: string) => fold(text).match(/[\p{L}\p{N}]+/gu) ?? [];

/** Whether every word typed starts a word of `value` (as plain search words match). */
function starts(value: string, typed: string): boolean {
  const have = words(value);
  const want = words(typed);
  return want.length > 0 && want.every((w) => have.some((h) => h.startsWith(w)));
}

/** Values to offer for fields that don't take them from the books. */
const FIXED_VALUES: Record<string, string[]> = {
  rating: ['5', '4+', '3+', '2+', '1+'],
  added: ['last 7 days', 'last 30 days', 'last year'],
  published: ['last year', 'last 10 years'],
  has: ['cover', 'file', 'series', 'rating', 'description'],
};

/** Field names to complete, with what they're called. `text` and the cover flag aren't typed as fields. */
const fieldNames = (fields: FilterField[]) => [
  ...fields.filter((f) => f.id !== 'text' && f.kind !== 'flag'),
  { id: 'has', label: 'Has', kind: 'flag' as const },
];

export function suggest(query: string, caret: number, items: Item[], fields: FilterField[], limit = 8): Suggestion[] {
  const { start, end } = wordAt(query, caret);
  const word = query.slice(start, caret);
  const replace = (text: string): Pick<Suggestion, 'query' | 'caret'> => {
    const after = query.slice(end).replace(/^\s*/, '');
    // A finished term gets a space after it, ready for the next; a bare `field:` waits for its value.
    const spaced = text.endsWith(':') ? text : `${text} `;
    return { query: query.slice(0, start) + spaced + after, caret: start + spaced.length };
  };
  const negate = word.startsWith('-') && word.length > 1;
  const typed = negate ? word.slice(1) : word;

  const field = /^([\p{L}\p{N}_.#-]+):(.*)$/u.exec(typed);
  if (field) {
    const name = field[1]!.toLowerCase();
    const known = fieldNames(fields).find((f) => f.id.toLowerCase() === name);
    if (!known) return [];
    const partial = field[2]!.replace(/^"/, '').replace(/"$/, '');
    const values = FIXED_VALUES[known.id] ?? fieldSuggestions(items, known.id);
    return values
      .filter((value) => !partial || starts(value, partial) || fold(value).startsWith(fold(partial)))
      .filter((value) => fold(value) !== fold(partial))
      .slice(0, limit)
      .map((value) => ({
        label: value,
        kind: known.label,
        ...replace(formatTerm({ kind: 'field', field: known.id, values: [value], negate })),
      }));
  }

  if (!typed || typed.startsWith('"')) return [];
  const out: Suggestion[] = [];
  const named = fieldNames(fields).filter((f) => f.id.toLowerCase().startsWith(typed.toLowerCase()) || starts(f.label, typed));
  for (const f of named.slice(0, 2)) out.push({ label: `${f.id}:`, kind: 'Field', ...replace(`${negate ? '-' : ''}${f.id}:`) });
  for (const [id, kind] of [['author', 'Author'], ['series', 'Series'], ['tag', 'Tag']] as const) {
    for (const value of fieldSuggestions(items, id).filter((v) => starts(v, typed)).slice(0, 4)) {
      out.push({ label: value, kind, ...replace(formatTerm({ kind: 'field', field: id, values: [value], negate })) });
    }
  }
  return out.slice(0, limit);
}
