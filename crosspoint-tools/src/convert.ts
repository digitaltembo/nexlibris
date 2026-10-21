import type { Converter } from '@nexlibris/tools/formats/convert/converters';
import { DEFAULT_OPTIMIZE_OPTIONS, OPTIMIZE_FIELDS, optimizeOptionsFrom, optimizerVersion, type OptimizeOptions } from './xteink/options';

/** The CrossPoint optimizer for a reader's screen, with its options recorded in its version. */
export function xteinkConverter(profile: 'X4' | 'X3', options: OptimizeOptions = DEFAULT_OPTIMIZE_OPTIONS): Converter {
  return {
    id: profile === 'X4' ? 'xteink-x4' : 'xteink-x3',
    from: ['epub'],
    to: profile === 'X4' ? 'x4.epub' : 'x3.epub',
    version: optimizerVersion(options),
    // Images made smaller and grayscale for the screen; the text and its structure kept.
    fidelity: 0.9,
    options: OPTIMIZE_FIELDS,
    withOptions: (values) => xteinkConverter(profile, optimizeOptionsFrom(values)),
    run: async (data) => {
      const [{ optimizeEpub }, { PROFILES }] = await Promise.all([import('./xteink/optimize'), import('./xteink/image')]);
      return optimizeEpub(data, PROFILES[profile], options);
    },
  };
}

/** Converting EPUBs to the X4's and X3's optimized EPUBs. */
export const CROSSPOINT_CONVERTERS: Converter[] = [xteinkConverter('X4'), xteinkConverter('X3')];
