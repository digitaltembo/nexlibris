import { isExternal, resolveHref, type EpubPackage } from './epub';
import { elements } from './markup';

/**
 * Just enough CSS for writing Kindle books: rewriting a stylesheet's references (`url()` and
 * `@import`) for KF8, which keeps the CSS, and a cascade for MOBI 6, which has none, so the
 * properties its markup can say (italic, bold, alignment, indents, spacing, sizes, page breaks)
 * become tags and attributes. Selectors are matched by the DOM's own `querySelectorAll`.
 */

/** A URL in CSS: bare where it can be, as kindlegen writes them (Calibre's reader expects KF8's references so). */
const cssUrl = (url: string) => (/[\s"'()\\]/.test(url) ? `url("${url.replace(/["\\]/g, '\\$&')}")` : `url(${url})`);

/** A stylesheet's text with each referenced URL replaced where `replace` gives one. */
export function rewriteCssUrls(css: string, replace: (url: string, isImport: boolean) => string | undefined): string {
  return css
    .replace(/@import\s+(?:url\(\s*)?(["']?)([^"')\s;]+)\1\s*\)?/gi, (all, _quote, url: string) => {
      const replaced = replace(url, true);
      return replaced === undefined ? all : `@import ${cssUrl(replaced)}`;
    })
    .replace(/url\(\s*(["']?)([^"')]+?)\1\s*\)/gi, (all, _quote, url: string) => {
      const replaced = replace(url, false);
      return replaced === undefined ? all : cssUrl(replaced);
    });
}

export interface Declaration {
  value: string;
  important: boolean;
}

export interface CssRule {
  selector: string;
  declarations: Map<string, Declaration>;
}

const stripComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, '');

/** Declarations (`name: value`), split at semicolons outside strings and parentheses. */
export function parseDeclarations(text: string): Map<string, Declaration> {
  const out = new Map<string, Declaration>();
  for (const part of splitOutside(stripComments(text), ';')) {
    const colon = part.indexOf(':');
    if (colon < 0) continue;
    const name = part.slice(0, colon).trim().toLowerCase();
    let value = part.slice(colon + 1).trim();
    const important = /!\s*important\s*$/i.test(value);
    if (important) value = value.replace(/!\s*important\s*$/i, '').trim();
    if (name && value) out.set(name, { value, important });
  }
  return out;
}

function splitOutside(text: string, separator: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote = '';
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = '';
    } else if (c === '"' || c === "'") quote = c;
    else if (c === '(') depth++;
    else if (c === ')') depth = Math.max(0, depth - 1);
    else if (c === separator && depth === 0) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(text.slice(start));
  return parts;
}

/** The index of the brace closing the block that opens at `open`. */
function blockEnd(css: string, open: number): number {
  let depth = 0;
  for (let i = open; i < css.length; i++) {
    if (css[i] === '{') depth++;
    else if (css[i] === '}' && --depth === 0) return i;
  }
  return css.length;
}

/**
 * A stylesheet's rules, in order, and the stylesheets it imports. Rules in `@media` blocks are
 * kept where `media` accepts the query; other at-rules (`@font-face`, `@page`) are left out.
 */
export function parseCss(css: string, media: (query: string) => boolean): { rules: CssRule[]; imports: string[] } {
  const text = stripComments(css);
  const rules: CssRule[] = [];
  const imports: string[] = [];
  let at = 0;
  while (at < text.length) {
    const open = text.indexOf('{', at);
    const semicolon = text.indexOf(';', at);
    const head = text.slice(at, open < 0 ? undefined : open).trim();
    if (head.startsWith('@') && semicolon >= 0 && (open < 0 || semicolon < open)) {
      // A statement: only @import matters.
      const statement = text.slice(at, semicolon);
      const url = /@import\s+(?:url\(\s*)?["']?([^"')\s;]+)/i.exec(statement)?.[1];
      if (url) imports.push(url);
      at = semicolon + 1;
      continue;
    }
    if (open < 0) break;
    const close = blockEnd(text, open);
    const body = text.slice(open + 1, close);
    if (/^@media\b/i.test(head)) {
      if (media(head.slice(6).trim())) rules.push(...parseCss(body, media).rules);
    } else if (!head.startsWith('@') && head) {
      const declarations = parseDeclarations(body);
      for (const selector of splitOutside(head, ',')) if (selector.trim()) rules.push({ selector: selector.trim(), declarations });
    }
    at = close + 1;
  }
  return { rules, imports };
}

/** A selector's specificity as one comparable number: ids, then classes, attributes and pseudo-classes, then types. */
export function specificity(selector: string): number {
  const ids = (selector.match(/#[\w-]+/g) ?? []).length;
  const classes = (selector.match(/\.[\w-]+|\[[^\]]*\]|:(?!:)[\w-]+/g) ?? []).length;
  const types = (selector.replace(/#[\w-]+|\.[\w-]+|\[[^\]]*\]|:+[\w-]+(\([^)]*\))?/g, ' ').match(/(^|[\s>+~])[a-z][\w-]*/gi) ?? []).length;
  return ids * 10000 + classes * 100 + types;
}

/** Whether a selector can't match elements (pseudo-elements, or pseudo-classes a document at rest never matches). */
const unmatchable = (selector: string) =>
  /::|:(before|after|first-letter|first-line|hover|focus|active|visited|target)\b/i.test(selector);

/** Each element's declarations from the rules that match it, the cascade's winner per property, then its own style attribute. */
export class Cascade {
  readonly #declared = new Map<Element, Map<string, { value: string; rank: number }>>();

  constructor(doc: Document, rules: CssRule[]) {
    rules.forEach((rule, order) => {
      if (unmatchable(rule.selector)) return;
      let matched: NodeListOf<Element>;
      try {
        matched = doc.querySelectorAll(rule.selector);
      } catch {
        return;
      }
      const rank = specificity(rule.selector) * 100000 + order;
      for (const el of matched) for (const [name, d] of rule.declarations) this.#set(el, name, d, rank);
    });
    for (const el of doc.querySelectorAll('[style]')) {
      for (const [name, d] of parseDeclarations(el.getAttribute('style') ?? '')) this.#set(el, name, d, 1e12);
    }
  }

  #set(el: Element, name: string, d: Declaration, rank: number) {
    if (d.important) rank += 1e13;
    let map = this.#declared.get(el);
    if (!map) this.#declared.set(el, (map = new Map()));
    for (const [longhand, value] of expand(name, d.value)) {
      const old = map.get(longhand);
      if (!old || old.rank <= rank) map.set(longhand, { value, rank });
    }
  }

  /** The value the cascade gives `el` itself for a property, lowercased; undefined where nothing sets it. */
  get(el: Element, property: string): string | undefined {
    return this.#declared.get(el)?.get(property)?.value.toLowerCase();
  }
}

/** A declaration as the longhands read here: margins split up, `font` and `text-decoration` read for what they say. */
function expand(name: string, value: string): [string, string][] {
  if (name === 'margin' || name === 'padding') {
    const parts = value.trim().split(/\s+/);
    const top = parts[0]!;
    const bottom = parts[2] ?? top;
    const right = parts[1] ?? top;
    const left = parts[3] ?? right;
    return [
      [`${name}-top`, top],
      [`${name}-right`, right],
      [`${name}-bottom`, bottom],
      [`${name}-left`, left],
    ];
  }
  if (name === 'font') {
    const out: [string, string][] = [];
    const words = value.toLowerCase().split(/\s+/);
    out.push(['font-style', words.some((w) => w === 'italic' || w === 'oblique') ? 'italic' : 'normal']);
    out.push(['font-weight', words.some((w) => w === 'bold' || w === 'bolder' || /^[6-9]00$/.test(w)) ? 'bold' : 'normal']);
    const size = words.find((w) => /^[\d.]+(px|pt|em|rem|%)(\/|$)|^(xx?-)?(small|large)$|^medium$|^smaller$|^larger$/.test(w));
    if (size) out.push(['font-size', size.split('/')[0]!]);
    return out;
  }
  if (name === 'text-decoration-line') return [['text-decoration', value]];
  if (name === 'break-before') return [['page-break-before', value]];
  if (name === 'break-after') return [['page-break-after', value]];
  return [[name, value]];
}

/** A length in ems (16px, 12pt), or undefined for one that isn't absolute or relative to the font. */
export function toEms(value: string | undefined): number | undefined {
  const match = value && /^(-?[\d.]+)(em|rem|px|pt|ex)?$/.exec(value.trim());
  if (!match) return undefined;
  const n = parseFloat(match[1]!);
  if (Number.isNaN(n)) return undefined;
  switch (match[2]) {
    case 'px':
      return n / 16;
    case 'pt':
      return n / 12;
    case 'ex':
      return n / 2;
    case undefined:
      return n === 0 ? 0 : undefined;
    default:
      return n;
  }
}

const FONT_SIZES: Record<string, number> = {
  'xx-small': 0.6,
  'x-small': 0.75,
  small: 0.89,
  medium: 1,
  large: 1.2,
  'x-large': 1.5,
  'xx-large': 2,
  smaller: 0.83,
  larger: 1.2,
};

/** A font size relative to the surrounding text, or undefined where it doesn't say. */
export function fontScale(value: string | undefined): number | undefined {
  if (!value) return undefined;
  if (value in FONT_SIZES) return FONT_SIZES[value];
  if (value.endsWith('%')) {
    const n = parseFloat(value);
    return Number.isNaN(n) ? undefined : n / 100;
  }
  return toEms(value);
}

/** A document's stylesheets' rules, in the order the cascade takes them: linked and inline, imports first, `@media` blocks where `media` takes them. Sheets are parsed once per `cache`. */
export async function documentRules(
  pkg: EpubPackage,
  path: string,
  doc: Document,
  cache: Map<string, CssRule[]>,
  media: (query: string) => boolean,
): Promise<CssRule[]> {
  const sheet = async (text: string, from: string, seen: Set<string>): Promise<CssRule[]> => {
    const { rules, imports } = parseCss(text, media);
    const imported: CssRule[] = [];
    for (const url of imports) {
      const target = resolveHref(from, url);
      if (seen.has(target) || isExternal(url)) continue;
      seen.add(target);
      imported.push(...(await linked(target, seen)));
    }
    return [...imported, ...rules];
  };
  const linked = async (target: string, seen: Set<string>) => {
    if (!cache.has(target)) cache.set(target, await sheet((await pkg.text(target)) ?? '', target, seen));
    return cache.get(target)!;
  };
  const rules: CssRule[] = [];
  for (const el of elements(doc)) {
    if (el.localName === 'link' && /stylesheet/i.test(el.getAttribute('rel') ?? '') && el.getAttribute('href') && !isExternal(el.getAttribute('href')!)) {
      rules.push(...(await linked(resolveHref(path, el.getAttribute('href')!), new Set())));
    } else if (el.localName === 'style' && el.textContent) {
      rules.push(...(await sheet(el.textContent, path, new Set())));
    }
  }
  return rules;
}
