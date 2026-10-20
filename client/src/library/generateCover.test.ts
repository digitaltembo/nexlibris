import { describe, expect, it } from 'vitest';
import { coverPalette, fitTitle, wrapLines } from './generateCover';

/** A monospace measure: each character 10px at 20px, scaling with the size. */
const measure = (text: string, size = 20) => text.length * size * 0.5;

describe('generated covers', () => {
  it('wraps words into lines that fit, a long word alone', () => {
    expect(wrapLines('The Left Hand of Darkness', 120, measure)).toEqual(['The Left', 'Hand of', 'Darkness']);
    expect(wrapLines('Supercalifragilistic is long', 100, measure)).toEqual(['Supercalifragilistic', 'is long']);
  });

  it('sets a title as large as fits in a few lines', () => {
    expect(fitTitle('Dune', 460, measure)).toEqual({ size: 96, lines: ['Dune'] });
    const long = fitTitle('The Hitchhiker’s Guide to the Galaxy and Other Stories of Great Length', 460, measure);
    expect(long.size).toBeLessThan(96);
    expect(long.lines.length).toBeLessThanOrEqual(5);
    expect(long.lines.every((line) => measure(line, long.size) <= 460)).toBe(true);
  });

  it('picks muted colours, dark or pale, from the random numbers', () => {
    const sequence = (...values: number[]) => () => values.shift() ?? 0;
    expect(coverPalette(sequence(0.5, 0, 0.1, 0))).toEqual({
      background: 'hsl(180 24% 20%)',
      ink: 'hsl(180 30% 93%)',
      line: 'hsl(180 25% 80% / 0.55)',
    });
    expect(coverPalette(sequence(0, 1, 0.9, 1)).ink).toBe('hsl(0 45% 16%)');
  });
});
