import type { BodyStats, LayoutLine, PageLayout } from './layout';

/**
 * A classified page's lines as blocks of text: paragraphs (by indents and short last lines),
 * displayed lines, headings and scene breaks, with hyphens at line ends resolved and typography
 * normalised; and a chapter's printed heading parsed. After scan2epub's `core/reflow.ts`,
 * `core/structure.ts` and `core/typography.ts`.
 */

/** Paragraph indents up to this multiple of the book's indent; bigger offsets are centred or displayed text. */
const MAX_INDENT = 4;
/** Displayed (centred or right-aligned) lines are narrower than this share of the text. */
const DISPLAY_MAX_WIDTH = 0.8;
const CENTER_TOLERANCE = 0.04;
const RIGHT_TOLERANCE = 0.02;
const RIGHT_MIN_OFFSET = 0.25;
/** A line starts a paragraph when indented at least this share of the book's indent. */
const INDENT_MIN = 0.5;
/** A line ending this many indents short of the right edge ends its paragraph (if the next line's first word would have fitted). */
const SHORT_LINE = 1.5;
/** A gap above a line of this many line pitches starts a paragraph (books that space paragraphs rather than indent them). */
const PARAGRAPH_GAP = 1.3;

export type Align = 'center' | 'right';

export interface Block {
  tag: 'p' | 'h2' | 'hr';
  lines: LayoutLine[];
  text: string;
  align?: Align;
  /** May start on an earlier page: not indented, at the top of a page that doesn't open a chapter. */
  continued: boolean;
  /** Its page's statistics, for joining it to the next page's first paragraph (`endsParagraph`). */
  stats: BodyStats;
}

/** Whether a word, joined from a hyphen at a line's end, is one the book uses: given by `PdfVocabulary`. */
export interface Vocabulary {
  /** A hyphen at a line's end splitting a word (`thou-` `sand`) rather than joining two. */
  softHyphen(head: string, tail: string): boolean;
}

/** The book's words, judging hyphens at line ends by how it spells them elsewhere. */
export class BookVocabulary implements Vocabulary {
  readonly #words = new Map<string, number>();

  constructor(texts: string[]) {
    for (const text of texts) {
      for (const word of text.toLowerCase().match(/[\p{L}\p{N}]+(?:-[\p{L}\p{N}]+)*/gu) ?? []) this.#words.set(word, (this.#words.get(word) ?? 0) + 1);
    }
  }

  softHyphen(head: string, tail: string): boolean {
    const h = head.toLowerCase().replace(/^[^\p{L}\p{N}]+/u, '');
    const t = tail.toLowerCase().replace(/[^\p{L}\p{N}]+$/u, '');
    const joined = this.#words.get(h + t) ?? 0;
    const hyphened = this.#words.get(`${h}-${t}`) ?? 0;
    // As the book spells it elsewhere; else a split word, as most hyphens at line ends in books are, unless a name follows ("Anglo-Saxon").
    if (joined || hyphened) return joined >= hyphened;
    return !/\p{Lu}/u.test(tail.replace(/^[^\p{L}]+/u, '')[0] ?? '');
  }
}

const isIndented = (line: LayoutLine, stats: BodyStats) => {
  const offset = line.x0 - stats.left;
  return INDENT_MIN * stats.indent < offset && offset < MAX_INDENT * stats.indent;
};

/** "center" or "right" for a short displayed line. */
function lineAlign(line: LayoutLine, stats: BodyStats): Align | undefined {
  const width = stats.width;
  if (width <= 0 || line.x1 - line.x0 > DISPLAY_MAX_WIDTH * width) return undefined;
  const offset = line.x0 - stats.left;
  if (Math.abs((line.x0 + line.x1) / 2 - stats.center) < CENTER_TOLERANCE * width && offset > MAX_INDENT * stats.indent) return 'center';
  if (Math.abs(line.x1 - stats.right) < RIGHT_TOLERANCE * width && offset > RIGHT_MIN_OFFSET * width) return 'right';
  return undefined;
}

/**
 * Whether a paragraph ends with `line`, before `next`: it ends short of the right edge, by more than
 * the space the next line's first word needed, which works for ragged text as for justified.
 */
export function endsParagraph(line: LayoutLine, next: LayoutLine | undefined, stats: BodyStats): boolean {
  if (line.x1 >= stats.right - SHORT_LINE * stats.indent) return false;
  const word = next?.words[0];
  if (!word) return true;
  const space = 0.3 * next.height;
  return line.x1 + space + (word.bbox[2] - word.bbox[0]) < stats.right + 0.25 * stats.indent;
}

/** Lines' texts as one: a hyphen splitting a word across lines dropped, one joining two kept. */
export function joinLines(texts: string[], vocabulary: Vocabulary): string {
  let out = '';
  for (const text of texts) {
    if (!out) {
      out = text;
      continue;
    }
    const last = [...out.slice(-4)];
    const [beforeLast, lastChar] = [last.at(-2), last.at(-1)];
    if (last.length > 1 && (lastChar === '-' || lastChar === '\u00ad') && /\p{L}/u.test(beforeLast ?? '') && /\p{L}/u.test([...text][0] ?? '')) {
      const head = out.slice(0, -1).split(' ').at(-1)!;
      const tail = text.split(' ')[0]!;
      out = (lastChar === '\u00ad' || vocabulary.softHyphen(head, tail) ? out.slice(0, -1) : out) + text;
    } else if (out.endsWith('—') || out.endsWith('–')) out += text;
    else out += ` ${text}`;
  }
  return out;
}

/** 'I WAS born' as 'I was born' after a drop cap, whose lead-in is set in capitals. */
function undoCapitalLeadIn(text: string): string {
  const tokens = text.split(' ');
  for (let i = 1; i < tokens.length; i++) {
    const letters = [...tokens[i]!].filter((c) => /\p{L}/u.test(c));
    if (letters.filter((c) => /\p{Lu}/u.test(c)).length >= 2 || (letters.length && letters.slice(1).some((c) => /\p{Lu}/u.test(c)))) tokens[i] = tokens[i]!.toLowerCase();
    else break;
  }
  return tokens.join(' ');
}

const LIGATURES: Record<string, string> = { 'ﬀ': 'ff', 'ﬁ': 'fi', 'ﬂ': 'fl', 'ﬃ': 'ffi', 'ﬄ': 'ffl', 'ﬅ': 'st', 'ﬆ': 'st' };
const OPENING_CONTEXT = new Set(' \t\n([{—–-“‘');
const ELISIONS = /(tis|twas|em|cause|n|round|til)(?![\p{L}\p{N}_])|\p{Nd}\p{Nd}/iuy;

function curlQuotes(text: string): string {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    const opening = OPENING_CONTEXT.has(i > 0 ? text[i - 1]! : ' ');
    if (ch === '"') out += opening ? '“' : '”';
    else if (ch === "'") {
      ELISIONS.lastIndex = i + 1;
      out += opening && !ELISIONS.test(text) ? '‘' : '’';
    } else out += ch;
  }
  return out;
}

/** Ligatures spelt out, dashes and ellipses as such, no spaces before punctuation, curly quotes. */
export function normalize(text: string): string {
  for (const [ligature, plain] of Object.entries(LIGATURES)) text = text.replaceAll(ligature, plain);
  return curlQuotes(
    text
      .replace(/\s*(--|—)\s*/gu, '—')
      .replace(/\.\s?\.\s?\./gu, '…')
      .replace(/\s+([,;:!?.])(?=\s|$)/gu, '$1')
      .replace(/\s{2,}/gu, ' ')
      .trim(),
  );
}

/** A page's blocks. */
export function pageBlocks(layout: PageLayout, vocabulary: Vocabulary): Block[] {
  const stats = layout.stats;
  const blocks: Block[] = [];
  let current: Block | undefined;
  const chapterStart = layout.flags.includes('chapter_start');
  const block = (tag: Block['tag'], line: LayoutLine, align?: Align): Block => ({ tag, lines: [line], text: '', ...(align && { align }), continued: false, stats });
  for (const line of layout.lines) {
    if (line.kind === 'heading') {
      current = undefined;
      blocks.push(block('h2', line));
    } else if (line.kind === 'scene_break') {
      current = undefined;
      blocks.push(block('hr', line));
    } else if (line.kind === 'body') {
      const align = lineAlign(line, stats);
      if (align) {
        // Lines set the same way make one paragraph.
        if (!current || current.align !== align) blocks.push((current = block('p', line, align)));
        else current.lines.push(line);
        continue;
      }
      const previous = current?.lines.at(-1);
      const spaced = previous && line.y0 - previous.y0 > PARAGRAPH_GAP * stats.pitch;
      if (!current || current.align || isIndented(line, stats) || spaced || endsParagraph(previous!, line, stats)) {
        const first = !blocks.length;
        current = block('p', line);
        current.continued = first && !chapterStart && !isIndented(line, stats);
        blocks.push(current);
      } else current.lines.push(line);
    }
  }
  const firstParagraph = blocks.find((b) => b.tag === 'p');
  for (const b of blocks) {
    if (b.tag === 'hr') continue;
    let text = joinLines(b.lines.map((l) => l.text), vocabulary);
    if (layout.dropCap && b === firstParagraph) text = undoCapitalLeadIn(text);
    b.text = normalize(text);
  }
  return blocks;
}

export interface Heading {
  section: string;
  ordinal?: number;
  /** Its label as printed ("Chapter IV", "Preface", "12"), in the book's own language. */
  label?: string;
  title: string;
}

const ROMAN: Record<string, number> = { m: 1000, d: 500, c: 100, l: 50, x: 10, v: 5, i: 1 };
const NUMBER_WORDS = 'one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty'.split(' ');
const SMALL_WORDS = new Set('a an and as at but by for from in into nor of on or the to with'.split(' '));
const LABELS: Record<string, string> = {
  chapter: 'chapter',
  chapitre: 'chapter',
  kapitel: 'chapter',
  capitolo: 'chapter',
  capítulo: 'chapter',
  hoofdstuk: 'chapter',
  part: 'part',
  partie: 'part',
  teil: 'part',
  parte: 'part',
  book: 'part',
  livre: 'part',
};
const SECTIONS = new Set(['dedication', 'epigraph', 'foreword', 'preface', 'introduction', 'acknowledgments', 'acknowledgements', 'part', 'chapter', 'prologue', 'epilogue', 'afterword', 'appendix']);

const ROMAN_NUMERAL = /^m{0,3}(cm|cd|d?c{0,3})(xc|xl|l?x{0,3})(ix|iv|v?i{0,3})$/iu;

function romanToInt(text: string): number | undefined {
  const t = [...text.toLowerCase()];
  if (!t.length || !ROMAN_NUMERAL.test(text)) return undefined;
  let total = 0;
  t.forEach((c, i) => {
    const value = ROMAN[c]!;
    total += i + 1 < t.length && ROMAN[t[i + 1]!]! > value ? -value : value;
  });
  return total > 0 ? total : undefined;
}

function parseOrdinal(text: string): number | undefined {
  const t = text.trim().replace(/\.+$/, '').trim();
  if (/^\p{Nd}+$/u.test(t)) return Number(t);
  const i = NUMBER_WORDS.indexOf(t.toLowerCase());
  return i >= 0 ? i + 1 : romanToInt(t);
}

/** All-capitals titles in title case; others as printed. */
export function titleCase(text: string): string {
  const letters = [...text].filter((c) => /\p{L}/u.test(c));
  if (!letters.length || letters.some((c) => /\p{Ll}/u.test(c))) return text;
  return text
    .toLowerCase()
    .split(/\s+/)
    .map((w, i) => (i && SMALL_WORDS.has(w) ? w : w.replace(/^(\P{L}*)(\p{L})/u, (_m, lead: string, c: string) => lead + c.toUpperCase())))
    .join(' ');
}

/** A section's kind, number and title from its printed heading's lines ("CHAPTER IV" / "THE STORM"). */
export function parseHeading(input: string[]): Heading {
  let texts = input.map((t) => t.trim().split(/\s+/).join(' ')).filter(Boolean);
  let section = 'chapter';
  let ordinal: number | undefined;
  let printed: string | undefined;
  if (texts.length) {
    const first = texts[0]!;
    const words = first.split(' ');
    const label = LABELS[words[0]!.toLowerCase().replace(/\.+$/, '')];
    const lowered = first.toLowerCase().replace(/\.+$/, '');
    if (label && words.length === 2 && parseOrdinal(words[1]!) !== undefined) {
      [section, ordinal, printed] = [label, parseOrdinal(words[1]!), `${titleCase(words[0]!)} ${words[1]!.replace(/\.$/, '')}`];
      texts = texts.slice(1);
    } else if (label && words.length > 2 && parseOrdinal(words[1]!.replace(/[.:]$/, '')) !== undefined) {
      // "Chapter 4: The Storm" on one line.
      [section, ordinal, printed] = [label, parseOrdinal(words[1]!.replace(/[.:]$/, '')), `${titleCase(words[0]!)} ${words[1]!.replace(/[.:]$/, '')}`];
      texts = [words.slice(2).join(' ').replace(/^[—–:.-]\s*/, ''), ...texts.slice(1)];
    } else if (SECTIONS.has(lowered)) {
      section = lowered === 'acknowledgements' ? 'acknowledgments' : lowered;
      printed = titleCase(first.replace(/\.+$/, ''));
      texts = texts.slice(1);
    } else if (words.length === 1 && parseOrdinal(first) !== undefined) {
      [ordinal, printed] = [parseOrdinal(first), first.replace(/\.+$/, '')];
      texts = texts.slice(1);
    } else if (/^\p{Nd}{1,3}\.?$/u.test(words[0]!) && words.length > 1) {
      // "3. Installing" or "3 Installing" on one line.
      [ordinal, printed] = [Number(words[0]!.replace(/\.$/, '')), words[0]!.replace(/\.$/, '')];
      texts = [words.slice(1).join(' '), ...texts.slice(1)];
    }
  }
  return {
    section,
    ...(ordinal !== undefined && { ordinal }),
    ...(printed && { label: printed }),
    title: texts.length ? titleCase(texts.join(' ')) : '',
  };
}

/** A heading's name for the table of contents, as printed: "Chapter IV: The Storm", "3. Installing", "Preface". */
export function headingLabel({ label, title }: Heading): string {
  if (!label) return title || 'Untitled';
  if (!title) return label;
  return /^[\p{Nd}ivxlcdm]+$/iu.test(label) ? `${label}. ${title}` : `${label}: ${title}`;
}
