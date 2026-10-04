import type { Item } from '@nexlibris/common';
import { fieldLabel } from './bookFields';
import { formatQuery, metadataKeys, orGroups, parseQuery, type FieldTerm, type Term } from './search';

/**
 * Filters as rules ("Rating is at least 4", "Tag is any of Fantasy, Science fiction"), in the
 * style of a smart playlist: what the filters dialog edits and the chips show. Rules are stored
 * and evaluated as search text (see `search.ts`), one field term per rule, joined by spaces when
 * all must match or by `or` when any may, so a device can keep its rules as a search string.
 */

export type FieldKind = 'text' | 'set' | 'rating' | 'number' | 'date' | 'flag';

export interface FilterField {
  /** The search field: `author`, `tag`, a metadata key, … */
  id: string;
  label: string;
  kind: FieldKind;
}

export type DateUnit = 'days' | 'weeks' | 'months' | 'years';

export type Condition =
  | 'contains'
  | 'notContains'
  | 'anyOf'
  | 'noneOf'
  | 'atLeast'
  | 'atMost'
  | 'is'
  | 'inLast'
  | 'after'
  | 'before'
  | 'present'
  | 'absent';

export interface Rule {
  field: string;
  condition: Condition;
  /** One value, or for `anyOf`/`noneOf` several. Numbers and dates as text; `inLast` as "30 days". */
  values: string[];
}

/** Rules joined by "all" or "any". */
export interface Filters {
  rules: Rule[];
  any: boolean;
}

export const EMPTY_FILTERS: Filters = { rules: [], any: false };

const BUILTIN_FIELDS: FilterField[] = [
  { id: 'text', label: 'Anything', kind: 'text' },
  { id: 'title', label: 'Title', kind: 'text' },
  { id: 'author', label: 'Author', kind: 'text' },
  { id: 'series', label: 'Series', kind: 'text' },
  { id: 'tag', label: 'Tags', kind: 'set' },
  { id: 'format', label: 'Format', kind: 'set' },
  { id: 'rating', label: 'Rating', kind: 'rating' },
  { id: 'added', label: 'Added', kind: 'date' },
  { id: 'originallyPublished', label: 'First published', kind: 'date' },
  { id: 'published', label: 'Edition published', kind: 'date' },
  { id: 'publisher', label: 'Publisher', kind: 'text' },
  { id: 'language', label: 'Language', kind: 'text' },
  { id: 'pages', label: 'Pages', kind: 'number' },
  { id: 'cover', label: 'Cover', kind: 'flag' },
  { id: 'isbn', label: 'ISBN', kind: 'text' },
];

/** Metadata the built-in fields cover or that isn't worth filtering on. */
const HIDDEN_METADATA = new Set(['seriesIndex', 'description', 'titleSort', 'authorSort', 'coverColor']);

const label = fieldLabel;

/** The fields rules can use: the built-in ones, then the library's other metadata fields. */
export function filterFields(items: Iterable<Item>): FilterField[] {
  const list = [...items];
  const builtin = new Set(BUILTIN_FIELDS.map((f) => f.id));
  const extra = [...metadataKeys(list)]
    .filter((key) => !builtin.has(key) && !HIDDEN_METADATA.has(key))
    .sort((a, b) => a.localeCompare(b))
    .map((key): FilterField => {
      const numeric = list.some((item) => typeof item.metadata[key] === 'number');
      return { id: key, label: label(key), kind: numeric ? 'number' : 'text' };
    });
  return [...BUILTIN_FIELDS, ...extra];
}

export const fieldById = (fields: FilterField[], id: string): FilterField =>
  fields.find((f) => f.id === id) ?? { id, label: label(id), kind: 'text' };

/** The conditions a kind of field offers, first the default. */
export const CONDITIONS: Record<FieldKind, Condition[]> = {
  text: ['contains', 'notContains', 'present', 'absent'],
  set: ['anyOf', 'noneOf', 'present', 'absent'],
  rating: ['atLeast', 'atMost', 'is', 'present', 'absent'],
  number: ['atLeast', 'atMost', 'is', 'present', 'absent'],
  date: ['inLast', 'after', 'before', 'present', 'absent'],
  flag: ['present', 'absent'],
};

/** How a condition reads for a field, e.g. "has no file" rather than "is empty" for formats. */
export function conditionLabel(field: FilterField, condition: Condition): string {
  return SPECIAL_LABELS[field.id]?.[condition] ?? CONDITION_LABELS[condition];
}

/** Labels that say the field themselves ("has a cover"), so a chip shows them without it. */
const SPECIAL_LABELS: Partial<Record<string, Partial<Record<Condition, string>>>> = {
  format: { anyOf: 'is', noneOf: 'isn’t', present: 'has a file', absent: 'has no file' },
  cover: { present: 'has a cover', absent: 'has no cover' },
  rating: { present: 'is rated', absent: 'isn’t rated' },
  tag: { anyOf: 'include', noneOf: 'don’t include', present: 'has tags', absent: 'has no tags' },
};

const CONDITION_LABELS: Record<Condition, string> = {
  contains: 'contains',
  notContains: 'doesn’t contain',
  anyOf: 'is any of',
  noneOf: 'is none of',
  atLeast: 'is at least',
  atMost: 'is at most',
  is: 'is',
  inLast: 'in the last',
  after: 'on or after',
  before: 'before',
  present: 'is set',
  absent: 'is empty',
};

/** Whether a rule has what it needs to filter anything (a new rule may not have a value yet). */
export const ruleComplete = (rule: Rule) =>
  rule.condition === 'present' || rule.condition === 'absent' || rule.values.some((v) => v.trim());

/** A rule as a search term. */
export function ruleTerm(rule: Rule): FieldTerm {
  const values = rule.values.map((v) => v.trim()).filter(Boolean);
  const term = (field: string, vs: string[], negate = false): FieldTerm => ({ kind: 'field', field, values: vs, negate });
  switch (rule.condition) {
    case 'present':
      return term('has', [rule.field]);
    case 'absent':
      return term('has', [rule.field], true);
    case 'contains':
    case 'anyOf':
    case 'is':
      return term(rule.field, values);
    case 'notContains':
    case 'noneOf':
      return term(rule.field, values, true);
    case 'atLeast':
      return term(rule.field, [`${values[0]}+`]);
    case 'atMost':
      return term(rule.field, [`<=${values[0]}`]);
    case 'inLast':
      return term(rule.field, [`last ${values[0]}`]);
    case 'after':
      return term(rule.field, [`>=${values[0]}`]);
    case 'before':
      return term(rule.field, [`<${values[0]}`]);
  }
}

/** A search term as a rule, if it's one a rule can express. */
export function termRule(term: Term, fields: FilterField[]): Rule | undefined {
  if (term.kind === 'or') return undefined;
  if (term.kind === 'words') {
    return term.phrase ? undefined : { field: 'text', condition: term.negate ? 'notContains' : 'contains', values: [term.text] };
  }
  if (term.field === 'has') {
    if (term.values.length !== 1) return undefined;
    const field = { tags: 'tag', file: 'format', formats: 'format', authors: 'author' }[term.values[0]!] ?? term.values[0]!;
    return { field, condition: term.negate ? 'absent' : 'present', values: [] };
  }
  const { kind } = fieldById(fields, term.field);
  const [value, ...rest] = term.values;
  if (value?.toLowerCase() === 'none' && !rest.length) {
    return { field: term.field, condition: term.negate ? 'present' : 'absent', values: [] };
  }
  if (kind === 'set') return { field: term.field, condition: term.negate ? 'noneOf' : 'anyOf', values: term.values };
  if (kind === 'text') {
    return rest.length ? undefined : { field: term.field, condition: term.negate ? 'notContains' : 'contains', values: [value!] };
  }
  if (term.negate || rest.length || value === undefined) return undefined;
  if (kind === 'rating' || kind === 'number') {
    const match = /^(?:(>=|<=)\s*)?(\d+(?:\.\d+)?)(\+)?$/.exec(value);
    if (!match) return undefined;
    const condition = match[1] === '>=' || match[3] ? 'atLeast' : match[1] === '<=' ? 'atMost' : 'is';
    return match[1] && match[3] ? undefined : { field: term.field, condition, values: [match[2]!] };
  }
  if (kind === 'date') {
    const last = /^last\s+(?:(\d+)\s+)?(day|week|month|year)s?$/i.exec(value);
    if (last) return { field: term.field, condition: 'inLast', values: [`${last[1] ?? 1} ${last[2]!.toLowerCase()}s`] };
    const compared = /^(>=|<)\s*(\d{4}(?:-\d{2}){0,2})$/.exec(value);
    if (compared) return { field: term.field, condition: compared[1] === '>=' ? 'after' : 'before', values: [compared[2]!] };
  }
  return undefined;
}

/** Filters as search text. Incomplete rules are left out. */
export function filtersQuery(filters: Filters): string {
  const terms = filters.rules.filter(ruleComplete).map(ruleTerm);
  return formatQuery(filters.any ? terms.flatMap((t, i) => (i ? [{ kind: 'or' } as const, t] : [t])) : terms);
}

/**
 * Search text as filters, or undefined if rules can't express it: a phrase, a comparison rules
 * don't offer, or `or` mixed with "and".
 */
export function parseFilters(query: string, fields: FilterField[]): Filters | undefined {
  const groups = orGroups(parseQuery(query, new Set(fields.map((f) => f.id))));
  const any = groups.length > 1;
  if (any && groups.some((g) => g.length > 1)) return undefined;
  const rules = groups.flat().map((term) => termRule(term, fields));
  return rules.every((r): r is Rule => !!r) ? { rules, any } : undefined;
}

/** A rule in words, for its chip: "Rating is at least 4", "Has no file", "Tags include Fantasy or Sci-fi". */
export function describeRule(rule: Rule, fields: FilterField[]): string {
  const field = fieldById(fields, rule.field);
  const condition = conditionLabel(field, rule.condition);
  const values = rule.values.map((v) => v.trim()).filter(Boolean);
  const presence = rule.condition === 'present' || rule.condition === 'absent';
  const subject = presence && SPECIAL_LABELS[field.id]?.[rule.condition] ? '' : `${field.label} `;
  const text = `${subject}${condition}`;
  if (rule.condition === 'present' || rule.condition === 'absent') return text.replace(/^./, (c) => c.toUpperCase());
  const shown = field.kind === 'rating' ? values.map((v) => `${v}★`) : values;
  const joined = shown.length > 1 ? `${shown.slice(0, -1).join(', ')} or ${shown.at(-1)}` : (shown[0] ?? '');
  return `${text} ${joined}`;
}

/** Values in use for a field, most common first, to suggest while typing a rule. */
export function fieldSuggestions(items: Iterable<Item>, field: string, limit = 200): string[] {
  const counts = new Map<string, number>();
  const add = (value: unknown) => {
    if (typeof value !== 'string' || !value.trim()) return;
    counts.set(value, (counts.get(value) ?? 0) + 1);
  };
  for (const item of items) {
    if (field === 'author') item.creators.forEach((c) => add(c.name));
    else if (field === 'tag') item.tags.forEach(add);
    else if (field === 'format') item.files.forEach((f) => add(f.format));
    else if (field === 'title') add(item.title);
    else add(item.metadata[field]);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([value]) => value);
}
