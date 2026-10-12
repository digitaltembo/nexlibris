import type { SettingField } from '../../devices/types';
import type { FormatId } from '../formats';
import type { ConvertContext } from './bookFromItem';
import { DEFAULT_OPTIMIZE_OPTIONS, OPTIMIZE_FIELDS, optimizeOptionsFrom, optimizerVersion, type OptimizeOptions } from './xteink/options';

export type { ConvertContext } from './bookFromItem';

export interface Converter {
  /** Stable id, recorded on derived files. */
  id: string;
  from: FormatId[];
  to: FormatId;
  /** Bump when output changes, so derived files can be regenerated. A converter with options records them in it. */
  version: string;
  /** Options asked for when converting; the converter as listed uses their defaults. */
  options?: SettingField[];
  /** This converter with the options' values, by key. */
  withOptions?(values: Record<string, string>): Converter;
  run(data: Blob, from: FormatId, ctx: ConvertContext): Promise<Blob>;
}

/** Conversions that run entirely in the browser. Their libraries load on first use. */
export const CONVERTERS: Converter[] = [
  {
    id: 'kindle-epub',
    from: ['mobi', 'azw3', 'azw'],
    to: 'epub',
    version: '1',
    run: async (data, _from, ctx) => (await import('../kindle')).kindleToEpub(data, ctx),
  },
  {
    id: 'txt-epub',
    from: ['txt'],
    to: 'epub',
    version: '1',
    run: async (data, _from, ctx) => (await import('./text')).txtToEpub(data, ctx),
  },
  {
    id: 'rtf-epub',
    from: ['rtf'],
    to: 'epub',
    version: '1',
    run: async (data, _from, ctx) => (await import('./text')).rtfToEpub(data, ctx),
  },
  {
    id: 'comic-epub',
    from: ['cbz', 'cbr'],
    to: 'epub',
    version: '1',
    run: async (data, from, ctx) => (await import('./comics')).comicToEpub(from as 'cbz' | 'cbr', data, ctx),
  },
  {
    id: 'cbr-cbz',
    from: ['cbr'],
    to: 'cbz',
    version: '1',
    run: async (data, _from, ctx) => (await import('./comics')).cbrToCbz(data, ctx),
  },
  xteinkConverter('X4'),
  xteinkConverter('X3'),
  {
    id: 'epub-txt',
    from: ['epub', 'x4.epub', 'x3.epub'],
    to: 'txt',
    version: '1',
    run: async (data, _from, ctx) => (await import('./text')).epubToTxt(data, ctx),
  },
];

export function convertersFrom(format: string): Converter[] {
  return CONVERTERS.filter((c) => (c.from as string[]).includes(format));
}

/** The CrossPoint optimizer for a reader's screen, with its options recorded in its version. */
export function xteinkConverter(profile: 'X4' | 'X3', options: OptimizeOptions = DEFAULT_OPTIMIZE_OPTIONS): Converter {
  return {
    id: profile === 'X4' ? 'xteink-x4' : 'xteink-x3',
    from: ['epub'],
    to: profile === 'X4' ? 'x4.epub' : 'x3.epub',
    version: optimizerVersion(options),
    options: OPTIMIZE_FIELDS,
    withOptions: (values) => xteinkConverter(profile, optimizeOptionsFrom(values)),
    run: async (data) => {
      const [{ optimizeEpub }, { PROFILES }] = await Promise.all([import('./xteink/optimize'), import('./xteink/image')]);
      return optimizeEpub(data, PROFILES[profile], options);
    },
  };
}
