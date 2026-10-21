import type { Link, Paragraph, Run, RunStyle } from './flow';
import { faceOf, type Fonts } from './fonts';

/** Breaking a paragraph into lines: greedily, at spaces (and between CJK characters), with no hyphenation. */

export interface Segment {
  text: string;
  style: RunStyle;
  /** The size it's drawn at: smaller for small capitals, superscripts and subscripts. */
  size: number;
  /** Raised (or lowered, negative) from the baseline. */
  rise: number;
  width: number;
  link?: Link;
}

interface Word {
  segments: Segment[];
  width: number;
  /** The width of the space after it, where there is one. */
  space: number;
  /** A forced line break. */
  newline?: boolean;
  anchors: string[];
}

export interface PlacedSegment extends Segment {
  x: number;
}

export interface Line {
  segments: PlacedSegment[];
  height: number;
  /** From the line's top to its baseline. */
  baseline: number;
  anchors: string[];
  /** Whether the line's spaces were stretched, so it's drawn word by word. */
  justified: boolean;
}

export const LINE_HEIGHT = 1.4;
const CJK = /([⺀-⿿　-〿぀-ヿ㄀-ㇿ㐀-䶿一-鿿가-힯豈-﫿＀-￯])/;

function segments(text: string, style: RunStyle, link: Link | undefined, fonts: Fonts): Segment[] {
  const scale = style.vertical ? 0.7 : 1;
  const rise = style.vertical === 'super' ? style.size * 0.33 : style.vertical === 'sub' ? -style.size * 0.15 : 0;
  const face = faceOf(style.bold, style.italic);
  const make = (t: string, size: number): Segment => ({ text: t, style, size, rise, width: fonts.width(t, style.family, face, size), ...(link && { link }) });
  if (!style.smallCaps) return [make(text, style.size * scale)];
  // Small capitals: lower case as capitals a size down.
  return (text.match(/\p{Ll}+|[^\p{Ll}]+/gu) ?? []).map((part) =>
    /\p{Ll}/u.test(part) ? make(part.toUpperCase(), style.size * scale * 0.78) : make(part, style.size * scale),
  );
}

/** A paragraph's runs as words, each the text between break opportunities. */
export function words(runs: Run[], pre: boolean, fonts: Fonts): Word[] {
  const out: Word[] = [];
  let current: Word | undefined;
  let anchors: string[] = [];
  const finish = () => {
    if (current) out.push(current);
    current = undefined;
  };
  const word = () => {
    if (!current) {
      current = { segments: [], width: 0, space: 0, anchors };
      anchors = [];
    }
    return current;
  };
  for (const run of runs) {
    if (run.anchors) (current ? current.anchors : anchors).push(...run.anchors);
    for (const part of run.text.split(/(\n| +)/).flatMap((p) => p.split(CJK))) {
      if (!part) continue;
      if (part === '\n') {
        finish();
        out.push({ segments: [], width: 0, space: 0, newline: true, anchors });
        anchors = [];
      } else if (part.startsWith(' ') && !/[^ ]/.test(part) && !(pre && !current)) {
        const space = fonts.width(part, run.style.family, faceOf(run.style.bold, run.style.italic), run.style.size);
        if (current) current.space += space;
        else if (out.length && !out.at(-1)!.newline) out.at(-1)!.space += space;
        finish();
      } else {
        const w = word();
        for (const segment of segments(part, run.style, run.link, fonts)) {
          w.segments.push(segment);
          w.width += segment.width;
        }
        if (CJK.test(part)) finish();
      }
    }
  }
  finish();
  if (anchors.length) out.push({ segments: [], width: 0, space: 0, anchors });
  return out;
}

/** A word too wide for a line, split into pieces that fit, a character at a time. */
function split(word: Word, width: number, fonts: Fonts): Word[] {
  const pieces: Word[] = [];
  let piece: Word = { segments: [], width: 0, space: 0, anchors: word.anchors };
  for (const segment of word.segments) {
    let text = '';
    for (const char of segment.text) {
      const next = fonts.width(text + char, segment.style.family, faceOf(segment.style.bold, segment.style.italic), segment.size);
      if (piece.width + next > width && (text || piece.segments.length)) {
        if (text) piece.segments.push({ ...segment, text, width: fonts.width(text, segment.style.family, faceOf(segment.style.bold, segment.style.italic), segment.size) });
        piece.width = piece.segments.reduce((n, s) => n + s.width, 0);
        pieces.push(piece);
        piece = { segments: [], width: 0, space: 0, anchors: [] };
        text = char;
      } else text += char;
    }
    if (text) {
      const s = { ...segment, text, width: fonts.width(text, segment.style.family, faceOf(segment.style.bold, segment.style.italic), segment.size) };
      piece.segments.push(s);
      piece.width += s.width;
    }
  }
  piece.space = word.space;
  pieces.push(piece);
  return pieces;
}

/** A paragraph set in lines `width` wide (the first `indent` in), with its lines' heights. */
export function setLines(para: Paragraph, width: number, fonts: Fonts, lineHeight = LINE_HEIGHT): Line[] {
  const base = para.runs.find((r) => r.text.trim())?.style.size ?? para.runs[0]?.style.size ?? 10;
  const all = words(para.runs, para.pre, fonts);
  // Only places, as an empty anchor makes: no height, as in a browser.
  if (all.every((w) => !w.segments.length && !w.newline)) {
    return [{ segments: [], height: 0, baseline: 0, anchors: [...para.anchors, ...all.flatMap((w) => w.anchors)], justified: false }];
  }
  const lines: Line[] = [];
  let line: Word[] = [];
  let lineWidth = 0;
  const available = () => Math.max(1, width - (lines.length ? 0 : Math.max(0, para.indent)));

  const commit = (last: boolean) => {
    const avail = available();
    const visible = line.filter((w) => w.segments.length);
    const content = visible.reduce((n, w, i) => n + w.width + (i < visible.length - 1 ? w.space : 0), 0);
    const gaps = visible.length - 1;
    const justify = para.align === 'justify' && !last && gaps > 0;
    const stretch = justify ? (avail - content) / gaps : 0;
    let x = lines.length ? 0 : para.indent;
    if (para.align === 'center') x += Math.max(0, (avail - content) / 2);
    else if (para.align === 'right') x += Math.max(0, avail - content);
    const placed: PlacedSegment[] = [];
    visible.forEach((w, i) => {
      for (const s of w.segments) {
        placed.push({ ...s, x });
        x += s.width;
      }
      if (i < visible.length - 1) x += w.space + stretch;
    });
    const sizes = placed.length ? placed.map((s) => s.style.size) : [base];
    const size = Math.max(...sizes);
    const height = size * lineHeight;
    lines.push({
      segments: placed,
      height,
      baseline: (height - size) / 2 + size * 0.8,
      anchors: line.flatMap((w) => w.anchors),
      justified: justify,
    });
    line = [];
    lineWidth = 0;
  };

  for (const word of all) {
    if (word.newline) {
      line.push(word);
      commit(true);
      continue;
    }
    const before = line.length ? line.at(-1)!.space : 0;
    if (line.some((w) => w.segments.length) && lineWidth + before + word.width > available()) commit(false);
    if (word.width > available()) {
      const pieces = split(word, available(), fonts);
      for (const [i, piece] of pieces.entries()) {
        line.push(piece);
        lineWidth += piece.width;
        if (i < pieces.length - 1) commit(false);
      }
      continue;
    }
    lineWidth += (line.length ? line.at(-1)!.space : 0) + word.width;
    line.push(word);
  }
  if (line.length || !lines.length) commit(true);
  // Places on the paragraph itself are its first line's.
  lines[0]!.anchors.unshift(...para.anchors);
  return lines;
}
