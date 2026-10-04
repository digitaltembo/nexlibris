import type { TextDoc } from './extract';

/**
 * Matching a full-text search against books' text. As with the library search, words match the
 * start of words ("harpoon" finds "harpooned"), ignoring case and accents; a quoted phrase
 * matches words in that order. A book matches when it has every term somewhere.
 */

/** A term: one word, or a phrase's words. */
export type TextTerm = string[];

export const fold = (text: string) => text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

const WORD = /[\p{L}\p{N}]+/gu;

export function parseTextQuery(query: string): TextTerm[] {
  const terms: TextTerm[] = [];
  for (const [, phrase, word] of query.matchAll(/"([^"]*)"?|(\S+)/g)) {
    const words = fold(phrase ?? word ?? '').match(WORD) ?? [];
    if (!words.length) continue;
    // A word like "don't" is two to the index, so it's searched for as a phrase.
    terms.push(phrase !== undefined || words.length > 1 ? words : [words[0]!]);
  }
  return terms;
}

/** A book's distinct words, sorted, with how often each occurs: enough to rule a book in or out without its text. */
export interface WordList {
  words: string[];
  counts: number[];
}

export function wordList(doc: TextDoc): WordList {
  const counts = new Map<string, number>();
  /** Each spelling folded once: a book has millions of words but tens of thousands of spellings. */
  const foldedOf = new Map<string, string>();
  for (const section of doc.sections) {
    for (const [word] of section.text.matchAll(WORD)) {
      let folded = foldedOf.get(word);
      if (folded === undefined) foldedOf.set(word, (folded = fold(word)));
      counts.set(folded, (counts.get(folded) ?? 0) + 1);
    }
  }
  const words = [...counts.keys()].sort();
  return { words, counts: words.map((w) => counts.get(w)!) };
}

/** The first index in `words` (sorted) not before `prefix`. */
function lowerBound(words: string[], prefix: string): number {
  let lo = 0;
  let hi = words.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (words[mid]! < prefix) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** How often words starting with `prefix` occur. */
function occurrences(list: WordList, prefix: string): number {
  let total = 0;
  for (let i = lowerBound(list.words, prefix); i < list.words.length && list.words[i]!.startsWith(prefix); i++) total += list.counts[i]!;
  return total;
}

/**
 * Whether a book may match, and how well: undefined if a term's word is missing; else the
 * occurrences of its rarest term, a rough relevance until its text is read. Phrases are checked
 * by word here, and in order by {@link findPassages}.
 */
export function score(list: WordList, terms: TextTerm[]): number | undefined {
  let rarest = Infinity;
  for (const term of terms) {
    let least = Infinity;
    for (const word of term) least = Math.min(least, occurrences(list, word));
    if (!least) return undefined;
    rarest = Math.min(rarest, least);
  }
  return terms.length ? rarest : undefined;
}

/** A place in a book where terms were found, with the text around them. */
export interface Passage {
  section: number;
  /** Where in the section's text the first match starts, for opening the reader there. */
  offset: number;
  /** The text shown, with `…` where it was cut. */
  snippet: string;
  /** Matches within `snippet`, as [start, end). */
  highlights: [number, number][];
  /** How many different terms it has: passages with more come first. */
  terms: number;
}

export interface BookMatch {
  passages: Passage[];
  /** Every match in the book, which can be more than the passages shown. */
  total: number;
}

const CONTEXT = 70;
/** Passages kept per book: more than anyone reads, few enough that a word in every book doesn't fill memory. */
export const MAX_PASSAGES = 100;

/** Every match of the terms in a book, grouped into passages; undefined if some term isn't there. */
export function findPassages(doc: TextDoc, terms: TextTerm[]): BookMatch | undefined {
  if (!terms.length) return undefined;
  const found = new Set<number>();
  const passages: Passage[] = [];
  let total = 0;
  doc.sections.forEach((section, index) => {
    const tokens = [...section.text.matchAll(WORD)].map((m) => ({ start: m.index, end: m.index + m[0].length, word: fold(m[0]) }));
    const hits: { start: number; end: number; term: number }[] = [];
    for (let i = 0; i < tokens.length; i++) {
      terms.forEach((term, t) => {
        // A phrase's words must follow each other: all but the last whole, the last as a start.
        const last = term.length - 1;
        for (let w = 0; w <= last; w++) {
          const token = tokens[i + w];
          if (!token || !(w === last ? token.word.startsWith(term[w]!) : token.word === term[w])) return;
        }
        hits.push({ start: tokens[i]!.start, end: tokens[i + last]!.end, term: t });
        found.add(t);
      });
    }
    total += hits.length;
    // Matches close together share a passage.
    let group: typeof hits = [];
    const flush = () => {
      if (!group.length) return;
      const from = cut(section.text, group[0]!.start - CONTEXT, -1);
      const to = cut(section.text, group.at(-1)!.end + CONTEXT, 1);
      const lead = from > 0 ? '…' : '';
      const snippet = lead + section.text.slice(from, to).replace(/\n/g, ' ') + (to < section.text.length ? '…' : '');
      passages.push({
        section: index,
        offset: group[0]!.start,
        snippet,
        highlights: group.map((h): [number, number] => [h.start - from + lead.length, h.end - from + lead.length]),
        terms: new Set(group.map((h) => h.term)).size,
      });
      group = [];
    };
    for (const hit of hits) {
      if (group.length && hit.start - group.at(-1)!.end > CONTEXT) flush();
      group.push(hit);
    }
    flush();
  });
  if (found.size < terms.length) return undefined;
  // Passages with more of the terms first; otherwise in the book's order.
  passages.sort((a, b) => b.terms - a.terms || a.section - b.section || a.offset - b.offset);
  return { passages: passages.slice(0, MAX_PASSAGES), total };
}

/** `at`, moved to the nearest space in direction `dir` (within 20 characters), and kept in the text. */
function cut(text: string, at: number, dir: -1 | 1): number {
  if (at <= 0) return 0;
  if (at >= text.length) return text.length;
  for (let i = 0; i < 20; i++) {
    const p = at + i * dir;
    if (/\s/.test(text[p] ?? '')) return dir < 0 ? p + 1 : p;
  }
  return at;
}

/** Where a reader opens for a passage: a CFI in an EPUB, a page of a PDF, or how far through a text file. */
export function locate(doc: TextDoc, passage: Pick<Passage, 'section' | 'offset'>): string {
  const section = doc.sections[passage.section]!;
  if (doc.kind === 'pdf') return section.ref;
  if (doc.kind === 'text') return section.text.length ? (passage.offset / section.text.length).toFixed(4) : '0';
  const nodes = section.nodes ?? [];
  // The last text node starting at or before the offset.
  let lo = 0;
  let hi = nodes.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (nodes[mid]![0] <= passage.offset) lo = mid;
    else hi = mid - 1;
  }
  const node = nodes[lo];
  if (!node) return `epubcfi(${section.ref})`;
  return `epubcfi(${section.ref}!${node[1]}:${Math.max(0, passage.offset - node[0])})`;
}

/** Where a passage is, to name it: its chapter (the last named before it), or the section's name, e.g. a PDF's page. */
export function placeOf(doc: TextDoc, passage: Pick<Passage, 'section' | 'offset'>): string | undefined {
  const section = doc.sections[passage.section];
  if (!section) return undefined;
  let place = section.labels?.[0]?.[1] ?? section.label;
  for (const [at, label] of section.labels ?? []) if (at <= passage.offset) place = label;
  return place;
}
