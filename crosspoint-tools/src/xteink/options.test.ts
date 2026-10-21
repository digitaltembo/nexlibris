import { describe, expect, it } from 'vitest';
import { xteinkConverter } from '../convert';
import { DEFAULT_OPTIMIZE_OPTIONS, OPTIMIZE_FIELDS, optimizeOptionsFrom, optimizerVersion } from './options';

describe('CrossPoint optimizer options', () => {
  it('records non-default options in the converter version', () => {
    expect(optimizerVersion(DEFAULT_OPTIMIZE_OPTIONS)).toBe('2');
    expect(optimizerVersion({ quality: 70, grayscale: false, autoCrop: true, splitParagraphs: false, splitChapters: true })).toBe(
      '2+q70+color+crop+nosplit+chapters',
    );
  });

  it('reads options from the convert dialog’s values, falling back to the defaults', () => {
    const defaults = Object.fromEntries(OPTIMIZE_FIELDS.map((f) => [f.key, f.default]));
    expect(optimizeOptionsFrom(defaults)).toEqual(DEFAULT_OPTIMIZE_OPTIONS);
    expect(optimizeOptionsFrom({})).toEqual(DEFAULT_OPTIMIZE_OPTIONS);
    expect(optimizeOptionsFrom({ quality: '60', grayscale: 'no', autoCrop: 'yes', splitParagraphs: 'no', splitChapters: 'yes' })).toEqual({
      quality: 60,
      grayscale: false,
      autoCrop: true,
      splitParagraphs: false,
      splitChapters: true,
    });
    expect(optimizeOptionsFrom({ quality: '400' }).quality).toBe(85);
    expect(optimizeOptionsFrom({ quality: 'high' }).quality).toBe(85);
  });

  it('makes a converter with the chosen options', () => {
    const x3 = xteinkConverter('X3');
    expect(x3).toMatchObject({ id: 'xteink-x3', to: 'x3.epub', version: '2', options: OPTIMIZE_FIELDS });
    expect(x3.withOptions!({ quality: '60' })).toMatchObject({ id: 'xteink-x3', to: 'x3.epub', version: '2+q60' });
  });
});
