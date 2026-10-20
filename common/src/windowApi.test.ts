import { describe, expect, it } from 'vitest';
import { hexColor } from './windowApi';

describe('hexColor', () => {
  it('reads computed and written colours', () => {
    expect(hexColor('rgb(28, 24, 19)')).toBe('#1c1813');
    expect(hexColor('rgba(253, 248, 229, 1)')).toBe('#fdf8e5');
    expect(hexColor('rgb(28 24 19)')).toBe('#1c1813');
    expect(hexColor(' #071F37 ')).toBe('#071f37');
    expect(hexColor('#111')).toBe('#111111');
  });

  it('gives up on anything else', () => {
    expect(hexColor('')).toBeUndefined();
    expect(hexColor('transparent')).toBeUndefined();
    expect(hexColor('color(display-p3 1 0 0)')).toBeUndefined();
  });
});
