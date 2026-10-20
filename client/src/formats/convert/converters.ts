import type { SettingField } from '../../devices/types';
import { EPUB_FORMATS, type FormatId } from '../formats';
import { PLUGIN_CONVERTERS } from '../../plugins/formats';
import type { ConvertContext } from './bookFromItem';

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

/** Conversions that run entirely in the browser, nexlibris's own and plugins'. Their libraries load on first use. */
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
  {
    id: 'epub-txt',
    from: EPUB_FORMATS,
    to: 'txt',
    version: '1',
    run: async (data, _from, ctx) => (await import('./text')).epubToTxt(data, ctx),
  },
  ...PLUGIN_CONVERTERS,
];

/** The formats conversions make, in the order they're first listed. */
export const CONVERSION_TARGETS: FormatId[] = [...new Set(CONVERTERS.map((c) => c.to))];

export function convertersFrom(format: string): Converter[] {
  return CONVERTERS.filter((c) => (c.from as string[]).includes(format));
}
