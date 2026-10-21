import { describe, expect, it } from 'vitest';
import { dominantColor } from './coverColor';

/** RGBA pixels: `count` of each colour. */
const pixels = (...runs: [count: number, rgba: [number, number, number, number]][]) =>
  new Uint8ClampedArray(runs.flatMap(([count, rgba]) => Array.from({ length: count }, () => rgba).flat()));

describe('dominantColor', () => {
  it('picks the colour with the most pixels', () => {
    expect(dominantColor(pixels([90, [20, 40, 160, 255]], [10, [200, 30, 30, 255]]))).toBe('#1428a0');
  });

  it('favours a saturated colour over a larger plain one, unless the plain one dominates', () => {
    expect(dominantColor(pixels([60, [240, 235, 220, 255]], [40, [200, 30, 30, 255]]))).toBe('#c81e1e');
    expect(dominantColor(pixels([90, [240, 235, 220, 255]], [10, [200, 30, 30, 255]]))).toBe('#f0ebdc');
  });

  it('skips transparent pixels, and gives nothing for none', () => {
    expect(dominantColor(pixels([50, [0, 0, 0, 0]], [5, [10, 120, 60, 255]]))).toBe('#0a783c');
    expect(dominantColor(pixels([5, [0, 0, 0, 0]]))).toBeUndefined();
  });
});
