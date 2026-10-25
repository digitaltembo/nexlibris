import { Fragment, createElement, type ReactNode } from 'react';
import strings from './en.json';

/**
 * All the app's text is in `en.json`, epubier's included (its `epubier` section, given to the reader whole as its
 * `strings`), so rewording or translating the app is editing that one file. A key is the dotted path to a string
 * (`'settings.title'`); `{name}` in a string is filled in from `vars`. A string that varies by number is an object of
 * plural forms keyed by `Intl.PluralRules` category (`one`, `few`, `many`, `other`, …) for the file's `locale`, chosen
 * by `vars.count`, as epubier's are.
 */
type Strings = typeof strings;

/** The dotted paths to every string (or set of plural forms) in `T`. */
type Paths<T, P extends string = ''> = {
  [K in keyof T & string]: T[K] extends string
    ? `${P}${K}`
    : T[K] extends { other: string }
      ? `${P}${K}`
      : Paths<T[K], `${P}${K}.`>;
}[keyof T & string];

export type TextKey = Paths<Omit<Strings, 'locale' | 'epubier'>>;
type Vars = Record<string, string | number | undefined>;

const plurals = (() => {
  try {
    return new Intl.PluralRules(strings.locale);
  } catch {
    return new Intl.PluralRules('en');
  }
})();

const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object';

function lookup(key: string, count: unknown): string | undefined {
  let value: unknown = strings;
  for (const part of key.split('.')) value = isObject(value) ? value[part] : undefined;
  if (isObject(value)) value = value[plurals.select(typeof count === 'number' ? count : 0)] ?? value.other;
  return typeof value === 'string' ? value : undefined;
}

/** The text at `key`, with `{name}`s filled in from `vars` (the key itself if there's no such text). */
export function t(key: TextKey, vars?: Vars): string {
  const text = lookup(key, vars?.count) ?? key;
  return vars ? text.replace(/\{(\w+)\}/g, (match, name: string) => (vars[name] === undefined ? match : String(vars[name]))) : text;
}

/** The text at a key made at run time (`fields.${key}`), or undefined if there's none. */
export function tIf(key: string, vars?: Vars): string | undefined {
  return lookup(key, vars?.count) === undefined ? undefined : t(key as TextKey, vars);
}

/** `t` for text with elements in it: each `{name}` filled in from `vars`, which may be React nodes. */
export function tn(key: TextKey, vars: Record<string, ReactNode>): ReactNode {
  const text = lookup(key, vars.count) ?? key;
  return text
    .split(/(\{\w+\})/)
    .map((part, i) => {
      const name = /^\{(\w+)\}$/.exec(part)?.[1];
      return createElement(Fragment, { key: i }, name !== undefined && name in vars ? vars[name] : part);
    });
}

/** The language the text is in, as a BCP 47 tag. */
export const locale: string = strings.locale;

/** epubier's text (see its `strings` option), from the same file. */
export const epubierStrings: Strings['epubier'] = strings.epubier;
