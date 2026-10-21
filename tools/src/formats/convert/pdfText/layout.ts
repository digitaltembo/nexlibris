import { union, type BBox, type Line, type Word } from './textLayer';

/**
 * Each line on a page classified (body, heading, scene break, running head, folio, noise), and
 * pages flagged (chapter openings, contents, blank or picture pages), from statistics gathered
 * across the book: after scan2epub's `core/layout.ts`, whose thresholds, measured on its sample
 * scans, are kept. Coordinates are page fractions (0–1, origin top left).
 */

export type Kind = 'body' | 'heading' | 'scene_break' | 'running_head' | 'folio' | 'noise';
export type Side = 'right' | 'left';

/** A line with at least this many letters and digits counts as a full body line when measuring. */
const BODY_LINE_MIN_ALNUM = 25;
/** Gaps bigger than this many line pitches set folios and headings apart from the text. */
const BAND_GAP = 1.25;
/** A chapter's text starts at least this many pitches below the usual top of the text. */
const SINK_PITCHES = 3;
export const PAGE_NUMBER = /^(\p{Nd}{1,4}|[ivxlcdm]{1,7})$/iu;
/** Characters that specks in the margins are read as. */
const BULLET_NOISE = new Set('•·*-_~.,\'`°');
const CONTENTS = /^(table of )?contents$/iu;

export const alnumCount = (text: string) => [...text].filter((c) => /[\p{L}\p{N}]/u.test(c)).length;

export function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** The value a share `q` of the way through the sorted values. */
function quantile(values: number[], q: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!;
}

export class LayoutLine {
  kind: Kind = 'body';
  constructor(public words: Word[]) {}

  get text() {
    return this.words.map((w) => w.text).join(' ');
  }
  get bbox(): BBox {
    return union(this.words.map((w) => w.bbox));
  }
  get x0() {
    return this.bbox[0];
  }
  get y0() {
    return this.bbox[1];
  }
  get x1() {
    return this.bbox[2];
  }
  get y1() {
    return this.bbox[3];
  }
  get height() {
    return this.y1 - this.y0;
  }
}

/** Where body text usually sits on pages of one side; the defaults only where a book has too little text to measure. */
export class BodyStats {
  left = 0.1;
  right = 0.9;
  top = 0.1;
  pitch = 0.025;
  indent = 0.03;
  /** A body line's height. */
  height = 0.02;

  constructor(values: Partial<Pick<BodyStats, 'left' | 'right' | 'top' | 'pitch' | 'indent' | 'height'>> = {}) {
    Object.assign(this, values);
  }
  get width() {
    return this.right - this.left;
  }
  get center() {
    return (this.left + this.right) / 2;
  }
}

export interface PageLayout {
  lines: LayoutLine[];
  stats: BodyStats;
  flags: ('blank' | 'image' | 'toc' | 'chapter_start' | 'irregular_layout')[];
  dropCap: boolean;
}

const byPosition = (a: LayoutLine, b: LayoutLine) => a.y0 - b.y0 || a.x0 - b.x0;

/** Pieces of one printed line read separately (a drop cap and the rest of its line) joined. */
export function mergeSplitLines(lines: Line[], maxGap = 0.04): LayoutLine[] {
  const merged: LayoutLine[] = [];
  const box = (line: Line) => union(line.words.map((w) => w.bbox));
  for (const line of [...lines].sort((a, b) => box(a)[1] - box(b)[1] || box(a)[0] - box(b)[0])) {
    const b = box(line);
    const target = merged.find((t) => {
      const overlap = Math.min(b[3], t.y1) - Math.max(b[1], t.y0);
      const gap = Math.max(b[0] - t.x1, t.x0 - b[2]);
      return overlap > 0.5 * Math.min(b[3] - b[1], t.height) && gap < maxGap;
    });
    if (target) target.words = [...target.words, ...line.words].sort((p, q) => p.bbox[0] - q.bbox[0]);
    else merged.push(new LayoutLine([...line.words]));
  }
  for (const line of merged) line.words = collapseLetterSpacing(line.words);
  return merged.sort(byPosition);
}

/** 'E S T O N I A' (letter-spaced capitals) as 'ESTONIA': runs of three or more single letters joined. */
export function collapseLetterSpacing(words: Word[]): Word[] {
  const out: Word[] = [];
  let run: Word[] = [];
  const flush = () => {
    if (run.length >= 3) out.push({ text: run.map((w) => w.text).join(''), bbox: union(run.map((w) => w.bbox)) });
    else out.push(...run);
    run = [];
  };
  for (const word of words) {
    if ([...word.text].length === 1 && /\p{L}/u.test(word.text)) run.push(word);
    else {
      flush();
      out.push(word);
    }
  }
  flush();
  return out;
}

const isSpeck = (word: Word) => !/[\p{L}\p{N}]/u.test(word.text) && [...word.text].every((c) => BULLET_NOISE.has(c));

function stripMarginBullets(line: LayoutLine, stats: BodyStats) {
  while (line.words.length > 1 && isSpeck(line.words[0]!) && line.words[0]!.bbox[2] < stats.left + stats.indent / 2) line.words = line.words.slice(1);
  while (line.words.length > 1 && isSpeck(line.words.at(-1)!) && line.words.at(-1)!.bbox[0] > stats.right + stats.indent / 4) line.words = line.words.slice(0, -1);
}

/** BodyStats per side, from all pages where one side has too little text to measure. */
export function computeStats(pages: [Side, LayoutLine[]][]): Record<Side, BodyStats> {
  const measure = (pageLines: LayoutLine[][]): BodyStats | null => {
    const body = pageLines.map((lines) => lines.filter((l) => alnumCount(l.text) >= BODY_LINE_MIN_ALNUM));
    const flat = body.flat();
    if (flat.length < 8) return null;
    const heights = median(flat.map((l) => l.height));
    const diffs = body.flatMap((lines) => lines.slice(1).map((b, i) => b.y0 - lines[i]!.y0).filter((d) => 0.5 * heights < d && d < 2.5 * heights));
    const left = median(flat.map((l) => l.x0));
    const offsets = flat.map((l) => l.x0 - left).filter((o) => 0.01 < o && o < 0.1);
    const tops = body.filter((lines) => lines.length).map((lines) => lines[0]!.y0);
    return new BodyStats({
      left,
      right: median(flat.map((l) => l.x1)),
      top: tops.length ? quantile(tops, 0.25) : 0.1,
      pitch: diffs.length ? median(diffs) : heights * 1.2,
      indent: offsets.length ? median(offsets) : 0.03,
      height: heights,
    });
  };
  const overall = measure(pages.map(([, lines]) => lines)) ?? new BodyStats();
  // Where text starts is measured over both sides: when chapters all open on one side, few of its pages have their text at the top.
  const side = (s: Side) => {
    const stats = measure(pages.filter(([p]) => p === s).map(([, lines]) => lines)) ?? overall;
    return new BodyStats({ ...stats, top: overall.top, height: stats.height });
  };
  return { right: side('right'), left: side('left') };
}

/** The book's stats moved to where this page's text sits: pages shift, but spacing and indents don't. */
function pageStats(lines: LayoutLine[], book: BodyStats): BodyStats {
  const full = lines.filter((l) => alnumCount(l.text) >= BODY_LINE_MIN_ALNUM);
  if (full.length < 5) return book;
  return new BodyStats({ left: median(full.map((l) => l.x0)), right: median(full.map((l) => l.x1)), top: Math.min(...full.map((l) => l.y0)), pitch: book.pitch, indent: book.indent, height: book.height });
}

type Row = LayoutLine[];

/** Lines sharing a baseline band (a running head's title and number). */
function rowsOf(lines: LayoutLine[]): Row[] {
  const rows: Row[] = [];
  for (const line of [...lines].sort((a, b) => a.y0 - b.y0)) {
    const center = (line.y0 + line.y1) / 2;
    const last = rows.at(-1);
    if (last && Math.min(...last.map((l) => l.y0)) <= center && center <= Math.max(...last.map((l) => l.y1))) last.push(line);
    else rows.push([line]);
  }
  return rows;
}

const rowText = (row: Row) => [...row].sort((a, b) => a.x0 - b.x0).map((l) => l.text).join(' ');
const gap = (upper: Row, lower: Row) => Math.min(...lower.map((l) => l.y0)) - Math.max(...upper.map((l) => l.y0));

/** A short line centred in the text ("CHAPTER I", a title). */
function isCenteredShort(line: LayoutLine, stats: BodyStats): boolean {
  const center = (line.x0 + line.x1) / 2;
  return line.x1 - line.x0 < 0.7 * stats.width && Math.abs(center - stats.center) < 0.08 * stats.width;
}

/** A row's text with its numbers taken out, to find the same head or foot on page after page. */
function edgeKey(row: Row): string {
  return rowText(row)
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => !PAGE_NUMBER.test(w.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '')))
    .join(' ')
    .replace(/[^\p{L}\p{N} ]/gu, '')
    .trim();
}

/** What each chapter's opening repeats ("Chapter 4"), which isn't a running head. */
const SECTION_LABEL = /^(chapter|part|book|section|letter|canto|act|scene|chapitre|kapitel|capitolo|capítulo|partie|teil)$/u;
/** Rows at the top or foot of this many pages, numbers aside, are running heads or feet. */
const REPEATS = 3;

/**
 * The heads and feet that pages repeat (a book's title, a chapter's, "Page 4 of 90"), as PDFs made
 * from text set them, whose sizes and gaps may not be a scan's.
 */
export function repeatedEdges(pages: LayoutLine[][]): Set<string> {
  const counts = new Map<string, number>();
  for (const lines of pages) {
    const rows = rowsOf(lines.filter((l) => alnumCount(l.text) > 0));
    if (rows.length < 2) continue;
    for (const key of new Set([edgeKey(rows[0]!), edgeKey(rows.at(-1)!)])) if (alnumCount(key) >= 2 && !SECTION_LABEL.test(key)) counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return new Set([...counts].filter(([, n]) => n >= REPEATS).map(([key]) => key));
}

/** A short line set larger than the text (a heading in a PDF made from text, which needn't be centred). */
const isLargeShort = (line: LayoutLine, stats: BodyStats) => line.height > 1.25 * stats.height && line.x1 - line.x0 < 0.7 * stats.width;

/**
 * A page's lines classified and the page flagged. `ink` is its share of dark pixels, where it was
 * drawn; `repeated` the heads and feet found across the book (`repeatedEdges`).
 */
export function classifyPage(lines: LayoutLine[], bookStats: BodyStats, ink?: number, repeated = new Set<string>()): PageLayout {
  const stats = pageStats(lines, bookStats);
  for (const line of lines) {
    if (alnumCount(line.text) > 0) {
      line.kind = 'body';
      stripMarginBullets(line, stats);
    } else line.kind = isCenteredShort(line, stats) && line.x0 > stats.left + stats.indent ? 'scene_break' : 'noise';
  }

  const rows = rowsOf(lines.filter((l) => l.kind !== 'noise'));
  const headRows: Row[] = [];
  const folioRows: Row[] = [];
  const far = BAND_GAP * stats.pitch;
  if (rows.length >= 2) {
    // A running head: a short row just above a full line of text.
    const [top, below] = rows as [Row, Row];
    const belowIsFull = Math.max(...below.map((l) => l.x1)) - Math.min(...below.map((l) => l.x0)) > 0.8 * stats.width;
    if (repeated.has(edgeKey(top)) && gap(top, below) > 1.05 * stats.pitch) headRows.push(top);
    else if (alnumCount(rowText(top)) < 40 && belowIsFull && gap(top, below) > 1.05 * stats.pitch && Math.max(...top.map((l) => l.x1 - l.x0)) < 0.7 * stats.width) headRows.push(top);
    // A head that's only a page number, at the top (not in scan2epub's sample, but common in PDFs made from text).
    else if (top.length && PAGE_NUMBER.test(rowText(top).replace(/^[.,\-–—\s]+|[.,\-–—\s]+$/g, '')) && gap(top, below) > far) headRows.push(top);
  }
  if (rows.length >= 2 && !headRows.includes(rows.at(-1)!)) {
    // A folio: a few characters set apart at the foot ("12", "- 123 -", "xiv").
    const [above, bottom] = rows.slice(-2) as [Row, Row];
    const n = alnumCount(rowText(bottom));
    if ((gap(above, bottom) > far && 0 < n && n <= 6) || (repeated.has(edgeKey(bottom)) && gap(above, bottom) > 1.05 * stats.pitch)) folioRows.push(bottom);
  }
  for (const line of headRows.flat()) line.kind = 'running_head';
  for (const line of folioRows.flat()) line.kind = 'folio';

  // Headings: short lines, centred or set larger than the text, set apart from the text around them.
  const content = rows.filter((row) => !headRows.includes(row) && !folioRows.includes(row));
  const headingLike = (row: Row) => row.length === 1 && (isCenteredShort(row[0]!, stats) || isLargeShort(row[0]!, stats));
  content.forEach((row, i) => {
    if (row[0]!.kind !== 'body' || !headingLike(row)) return;
    const previousHeading = i > 0 && content[i - 1]![0]!.kind === 'heading';
    const above = i === 0 || previousHeading || gap(content[i - 1]!, row) > far;
    const below = i === content.length - 1 || gap(row, content[i + 1]!) > far || headingLike(content[i + 1]!);
    if (above && below) row[0]!.kind = 'heading';
  });

  const layout: PageLayout = { lines: [...lines].sort(byPosition), stats, flags: [], dropCap: false };
  layout.flags = flagsOf(layout, bookStats, ink);
  layout.dropCap = layout.flags.includes('chapter_start') && hasDropCap(layout);
  return layout;
}

function hasDropCap(layout: PageLayout): boolean {
  const body = layout.lines.filter((l) => l.kind === 'body');
  if (!body.length || body[0]!.words.length < 2) return false;
  const [first, second] = [body[0]!.words[0]!.text, body[0]!.words[1]!.text];
  return [...first].length === 1 && /\p{Lu}/u.test(first) && [...second].slice(1).some((c) => /\p{Lu}/u.test(c));
}

/** Share of dark pixels above which a page with little text is a picture. */
const IMAGE_INK = 0.2;

function flagsOf(layout: PageLayout, stats: BodyStats, ink = 0): PageLayout['flags'] {
  const body = layout.lines.filter((l) => l.kind === 'body');
  const headings = layout.lines.filter((l) => l.kind === 'heading');
  const flags: PageLayout['flags'] = [];
  if (!body.length && !headings.length) return [ink > IMAGE_INK ? 'image' : 'blank'];
  if (ink > IMAGE_INK && body.length < 10) flags.push('image');
  if ([...headings, ...body].some((l) => CONTENTS.test(l.text.trim()))) flags.push('toc');
  else if (body.length >= 5) {
    const endingInNumber = body.filter((l) => PAGE_NUMBER.test(l.words.at(-1)!.text.replace(/^[.,]+|[.,]+$/g, ''))).length;
    if (endingInNumber / body.length > 0.4) flags.push('toc');
  }
  if (headings.length && body.length && headings[0]!.y0 < body[0]!.y0 && body[0]!.y0 > stats.top + SINK_PITCHES * stats.pitch) flags.push('chapter_start');
  if (body.length >= 5 && !flags.includes('toc')) {
    const widths = body.map((l) => l.x1 - l.x0);
    const offsets = body.map((l) => Math.abs(l.x0 - stats.left));
    if (median(widths) < 0.75 * stats.width || median(offsets) > 2 * stats.indent) flags.push('irregular_layout');
  }
  return flags;
}

