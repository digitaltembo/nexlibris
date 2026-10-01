import { createDevice, createItem, createLibrary, type FileRef } from '@nexlibris/common';
import { describe, expect, it } from 'vitest';
import { planSync } from '../../devices/plan';
import { xteinkConverter } from '../../formats/convert/converters';
import { DEFAULT_OPTIMIZE_OPTIONS, optimizerVersion } from '../../formats/convert/xteink/options';
import { crosspoint, optimizeOptions } from './index';

const x4 = crosspoint.deviceTypes.find((t) => t.id === 'crosspoint.x4')!;

describe('CrossPoint optimizer settings', () => {
  it('records non-default options in the converter version', () => {
    expect(optimizerVersion(DEFAULT_OPTIMIZE_OPTIONS)).toBe('1');
    expect(optimizerVersion({ quality: 70, grayscale: false, autoCrop: true, splitText: false })).toBe('1+q70+color+crop+nosplit');
    expect(xteinkConverter('X3', { ...DEFAULT_OPTIMIZE_OPTIONS, quality: 60 })).toMatchObject({ id: 'xteink-x3', to: 'x3.epub', version: '1+q60' });
  });

  it('reads options from settings, falling back to the defaults', () => {
    const device = (settings: Record<string, string>) => createDevice({ name: 'X4', type: x4.id, settings });
    expect(optimizeOptions(device({}))).toEqual(DEFAULT_OPTIMIZE_OPTIONS);
    expect(optimizeOptions(device({ quality: '60', grayscale: 'no', autoCrop: 'yes', splitText: 'no' }))).toEqual({
      quality: 60,
      grayscale: false,
      autoCrop: true,
      splitText: false,
    });
    expect(optimizeOptions(device({ quality: '400' })).quality).toBe(85);
    expect(optimizeOptions(device({ quality: 'high' })).quality).toBe(85);
  });

  it('remakes the optimized copy when the settings change', () => {
    const epub: FileRef = { hash: 'e', size: 1, format: 'epub' };
    const made: FileRef = { hash: 'x', size: 1, format: 'x4.epub', derivedFrom: { hash: 'e', converter: 'xteink-x4', converterVersion: '1' } };
    const item = createItem({ title: 'Dune', files: [epub, made] });
    const library = { ...createLibrary('L'), items: { [item.id]: item } };
    const plan = (settings: Record<string, string>) =>
      planSync(library, { ...createDevice({ name: 'X4', type: x4.id, settings }), items: [item.id] }, x4, { files: [] });

    expect(plan({}).uploads).toMatchObject([{ file: { hash: 'x' } }]);
    const changed = plan({ quality: '60' }).uploads;
    expect(changed).toMatchObject([{ file: { hash: 'e' }, convert: { version: '1+q60' } }]);
  });
});
