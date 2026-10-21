/**
 * A PDF page's text layer as lines of words, from pdf.js's text content, after scan2epub's
 * `core/textlayer.ts`. pdf.js gives runs of text, each with its matrix and width, but not where
 * each glyph is, so a word's place in its run is its share of the run's characters. Boxes are page
 * fractions (0–1, origin top left).
 */

export type BBox = [x0: number, y0: number, x1: number, y1: number];

export interface Word {
  text: string;
  bbox: BBox;
}

export interface Line {
  words: Word[];
}

/** What pdf.js's getTextContent gives, as far as this reads it. */
export interface TextItem {
  str: string;
  width: number;
  transform: number[];
  fontName: string;
}
export type TextStyles = Record<string, { ascent: number; descent: number }>;

/** A gap between runs wider than this many ems starts a new line (a column, a page number, a dot leader). */
const MAX_GAP = 1;

export function union(boxes: BBox[]): BBox {
  return [
    Math.min(...boxes.map((b) => b[0])),
    Math.min(...boxes.map((b) => b[1])),
    Math.max(...boxes.map((b) => b[2])),
    Math.max(...boxes.map((b) => b[3])),
  ];
}

export const lineBox = (line: Line) => union(line.words.map((w) => w.bbox));
export const lineText = (line: Line) => line.words.map((w) => w.text).join(' ');

interface Run {
  words: Word[];
  start: [number, number];
  end: [number, number];
  /** Unit vector along the baseline. */
  dir: [number, number];
  size: number;
  /** Whether its text starts or ends with a space. */
  spaceBefore: boolean;
  spaceAfter: boolean;
}

function readRun(item: TextItem, styles: TextStyles, view: number[]): Run | null {
  const [a = 0, b = 0, c = 0, d = 0, e = 0, f = 0] = item.transform;
  const scale = Math.hypot(a, b);
  const chars = [...item.str];
  if (!scale || !chars.length) return null;
  const step = item.width / scale / chars.length;
  const style = styles[item.fontName] ?? { ascent: 0.8, descent: -0.2 };
  const [vx0 = 0, vy0 = 0, vx1 = 1, vy1 = 1] = view;
  const words: Word[] = [];
  const text = chars.join('');
  for (const m of text.matchAll(/\S+/gu)) {
    const start = [...text.slice(0, m.index)].length;
    const corners = [start * step, (start + [...m[0]].length) * step].flatMap((u) =>
      [style.descent, style.ascent].map((v) => [a * u + c * v + e, b * u + d * v + f] as const),
    );
    const xs = corners.map((p) => p[0]);
    const ys = corners.map((p) => p[1]);
    words.push({
      text: m[0],
      bbox: [
        (Math.min(...xs) - vx0) / (vx1 - vx0),
        (vy1 - Math.max(...ys)) / (vy1 - vy0),
        (Math.max(...xs) - vx0) / (vx1 - vx0),
        (vy1 - Math.min(...ys)) / (vy1 - vy0),
      ],
    });
  }
  const length = chars.length * step;
  return {
    words,
    start: [e, f],
    end: [a * length + e, b * length + f],
    dir: [a / scale, b / scale],
    size: Math.hypot(c, d) || scale,
    spaceBefore: /^\s/u.test(text),
    spaceAfter: /\s$/u.test(text),
  };
}

/** How far `next` starts along the baseline of `last`, and across it, in ems. */
function offset(last: Run, next: Run): { along: number; across: number } {
  const dx = next.start[0] - last.end[0];
  const dy = next.start[1] - last.end[1];
  const size = Math.min(last.size, next.size);
  return { along: (dx * last.dir[0] + dy * last.dir[1]) / size, across: (-dx * last.dir[1] + dy * last.dir[0]) / size };
}

/** Whether `next` carries on the line `last` ends: further along its baseline, not above or below it, nor far off. */
function continues(last: Run, next: Run): boolean {
  const { along, across } = offset(last, next);
  return along > -0.5 && along < MAX_GAP && Math.abs(across) < 0.5;
}

/** Whether `next` carries on the word `last` ends, as runs split for kerning or small capitals do. */
const touches = (last: Run, next: Run) => !last.spaceAfter && !next.spaceBefore && Math.abs(offset(last, next).along) < 0.12;

/** A page's lines, in reading order (top to bottom, then left to right). */
export function textLayerLines(items: TextItem[], styles: TextStyles, view: number[]): Line[] {
  const lines: { words: Word[]; last: Run; closed?: boolean }[] = [];
  for (const item of items) {
    if (typeof item.str !== 'string') continue;
    const run = readRun(item, styles, view);
    if (!run) continue;
    const line = lines.at(-1);
    if (line && !line.closed && continues(line.last, run)) {
      const [first, ...rest] = run.words;
      const previous = line.words.at(-1);
      if (first && previous && touches(line.last, run)) {
        line.words[line.words.length - 1] = { text: previous.text + first.text, bbox: union([previous.bbox, first.bbox]) };
        line.words.push(...rest);
      } else line.words.push(...run.words);
      line.last = run;
      // pdf.js stands a wide space between a running head's parts, say; what follows it is apart.
      if (!run.words.length && Math.hypot(run.end[0] - run.start[0], run.end[1] - run.start[1]) > MAX_GAP * run.size) line.closed = true;
    } else if (run.words.length) lines.push({ words: [...run.words], last: run });
    else if (line) line.last = run;
  }
  return lines
    .map(({ words }) => ({ words }))
    .sort((a, b) => {
      const [ba, bb] = [lineBox(a), lineBox(b)];
      return Math.round(ba[1] * 1000) - Math.round(bb[1] * 1000) || ba[0] - bb[0];
    });
}
