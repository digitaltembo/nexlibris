import type { Item } from '@nexlibris/common';
import type { NewCover } from './editCover';

/**
 * A plain cover made for a book that has none: the title in a serif face over a field of one
 * colour, a short rule, and the authors in spaced capitals near the foot, inside a fine frame.
 * The colour is picked at random each time (a muted hue, dark or pale), so asking again gives
 * another; everything else follows from the book.
 */

export const COVER_WIDTH = 600;
export const COVER_HEIGHT = 900;
const MARGIN = 70;
const FRAME_INSET = 26;
const MAX_TITLE_LINES = 5;
const SERIF = 'Georgia, "Times New Roman", serif';
const SANS = '"Helvetica Neue", Helvetica, Arial, sans-serif';

export interface CoverPalette {
  background: string;
  ink: string;
  /** The frame and rule: the ink, fainter. */
  line: string;
}

/** A muted colour scheme from `random` (0 ≤ n < 1): mostly deep fields with pale ink, some pale fields with dark ink. */
export function coverPalette(random: () => number = Math.random): CoverPalette {
  const hue = Math.round(random() * 360);
  const saturation = 24 + Math.round(random() * 16);
  if (random() < 0.7) {
    const lightness = 20 + Math.round(random() * 14);
    return {
      background: `hsl(${hue} ${saturation}% ${lightness}%)`,
      ink: `hsl(${hue} 30% 93%)`,
      line: `hsl(${hue} 25% 80% / 0.55)`,
    };
  }
  const lightness = 82 + Math.round(random() * 8);
  return {
    background: `hsl(${hue} ${saturation}% ${lightness}%)`,
    ink: `hsl(${hue} 45% 16%)`,
    line: `hsl(${hue} 35% 25% / 0.45)`,
  };
}

/** Words into lines no wider than `width` by `measure`; a word too wide alone gets a line of its own. */
export function wrapLines(text: string, width: number, measure: (text: string) => number): string[] {
  const lines: string[] = [];
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const last = lines.at(-1);
    if (last !== undefined && measure(`${last} ${word}`) <= width) lines[lines.length - 1] = `${last} ${word}`;
    else lines.push(word);
  }
  return lines;
}

/**
 * The largest title size (from 96px down) whose lines all fit and are few enough, with those
 * lines. At the smallest size the lines are what they are.
 */
export function fitTitle(title: string, width: number, measure: (text: string, size: number) => number): { size: number; lines: string[] } {
  for (let size = 96; size > 40; size -= 4) {
    const lines = wrapLines(title, width, (text) => measure(text, size));
    if (lines.length <= MAX_TITLE_LINES && lines.every((line) => measure(line, size) <= width)) return { size, lines };
  }
  return { size: 40, lines: wrapLines(title, width, (text) => measure(text, 40)) };
}

const authorsOf = (item: Pick<Item, 'creators'>) =>
  item.creators
    .filter((c) => c.role === 'aut')
    .map((c) => c.name)
    .slice(0, 3)
    .join(', ');

/** Draws the cover for `item`; throws where there's no canvas to draw on. */
export async function generateCover(item: Pick<Item, 'title' | 'creators'>, random: () => number = Math.random): Promise<NewCover> {
  const canvas =
    typeof OffscreenCanvas === 'function'
      ? new OffscreenCanvas(COVER_WIDTH, COVER_HEIGHT)
      : Object.assign(document.createElement('canvas'), { width: COVER_WIDTH, height: COVER_HEIGHT });
  const context = canvas.getContext('2d') as OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D | null;
  if (!context) throw new Error('There’s no canvas to draw a cover on here.');
  const palette = coverPalette(random);
  const inner = COVER_WIDTH - 2 * MARGIN;

  context.fillStyle = palette.background;
  context.fillRect(0, 0, COVER_WIDTH, COVER_HEIGHT);
  context.strokeStyle = palette.line;
  context.lineWidth = 2;
  context.strokeRect(FRAME_INSET, FRAME_INSET, COVER_WIDTH - 2 * FRAME_INSET, COVER_HEIGHT - 2 * FRAME_INSET);

  // The title, centred a little above the middle.
  context.fillStyle = palette.ink;
  context.textAlign = 'center';
  context.textBaseline = 'alphabetic';
  const { size, lines } = fitTitle(item.title.trim() || 'Untitled', inner, (text, at) => {
    context.font = `${at}px ${SERIF}`;
    return context.measureText(text).width;
  });
  context.font = `${size}px ${SERIF}`;
  const leading = size * 1.15;
  const block = leading * (lines.length - 1) + size;
  const top = COVER_HEIGHT * 0.4 - block / 2 + size * 0.8;
  lines.forEach((line, i) => context.fillText(line, COVER_WIDTH / 2, top + i * leading));

  // A short rule under it.
  const ruleY = top + leading * (lines.length - 1) + size * 0.75;
  context.strokeStyle = palette.ink;
  context.lineWidth = 2;
  context.beginPath();
  context.moveTo(COVER_WIDTH / 2 - 30, ruleY);
  context.lineTo(COVER_WIDTH / 2 + 30, ruleY);
  context.stroke();

  // The authors, in spaced capitals near the foot (spaced where the canvas can, as in Chrome).
  const authors = authorsOf(item).toUpperCase();
  if (authors) {
    let authorSize = 24;
    const setAuthorFont = () => {
      context.font = `${authorSize}px ${SANS}`;
      if ('letterSpacing' in context) context.letterSpacing = `${Math.round(authorSize * 0.18)}px`;
    };
    setAuthorFont();
    while (authorSize > 14 && context.measureText(authors).width > inner) {
      authorSize -= 2;
      setAuthorFont();
    }
    context.fillText(authors, COVER_WIDTH / 2, COVER_HEIGHT - 120, inner);
  }

  const data =
    canvas instanceof HTMLCanvasElement
      ? await new Promise<Blob>((resolve, reject) =>
          canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('Couldn’t encode the cover.'))), 'image/jpeg', 0.92),
        )
      : await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.92 });
  return { data, mediaType: 'image/jpeg' };
}
