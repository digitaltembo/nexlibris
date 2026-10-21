import type { OptionField } from '../../options';
import { EPUB_FORMATS, type FormatId } from '../formats';
import type { ConvertContext } from './bookFromItem';
import { DEFAULT_PDF_OPTIONS, PDF_FIELDS, pdfOptionsFrom, pdfVersion, type PdfOptions } from './pdf/options';
import { DEFAULT_PDF_TEXT_OPTIONS, PDF_TEXT_FIELDS, pdfTextOptionsFrom, pdfTextVersion, type PdfTextOptions } from './pdfText/options';

export type { ConvertContext } from './bookFromItem';

export interface Converter {
  /** Stable id, recorded on derived files. */
  id: string;
  from: FormatId[];
  to: FormatId;
  /** Bump when output changes, so derived files can be regenerated. A converter with options records them in it. */
  version: string;
  /**
   * How much of a book the conversion keeps, from 1 (everything of value: a repackaging) towards 0 (only the
   * words, as plain text keeps). Conversions chain by the most kept (`pathFidelity`), so a lossy format is only a
   * step on the way where nothing better reaches.
   */
  fidelity: number;
  /** Options asked for when converting; the converter as listed uses their defaults. */
  options?: OptionField[];
  /** This converter with the options' values, by key. */
  withOptions?(values: Record<string, string>): Converter;
  run(data: Blob, from: FormatId, ctx: ConvertContext): Promise<Blob>;
}

/** EPUB typeset as a PDF, with its options (page size, headers, page and chapter numbers) recorded in its version. */
export function pdfConverter(options: PdfOptions = DEFAULT_PDF_OPTIONS): Converter {
  return {
    id: 'epub-pdf',
    from: EPUB_FORMATS,
    to: 'pdf',
    version: pdfVersion(options),
    // The text and its typography kept, on fixed pages that no longer reflow.
    fidelity: 0.7,
    options: PDF_FIELDS,
    withOptions: (values) => pdfConverter(pdfOptionsFrom(values)),
    run: async (data, _from, ctx) => (await import('./pdf/write')).epubToPdf(data, ctx, options),
  };
}

/**
 * A PDF's text layer reflowed as an EPUB (no OCR: a PDF of images alone is refused), with its
 * options (which margins to ignore, where chapters come from) recorded in its version.
 */
export function pdfTextConverter(options: PdfTextOptions = DEFAULT_PDF_TEXT_OPTIONS): Converter {
  return {
    id: 'pdf-epub',
    from: ['pdf'],
    to: 'epub',
    version: pdfTextVersion(options),
    // Paragraphs and chapters as the layout suggests them, the page's look gone.
    fidelity: 0.6,
    options: PDF_TEXT_FIELDS,
    withOptions: (values) => pdfTextConverter(pdfTextOptionsFrom(values)),
    run: async (data, _from, ctx) => (await import('./pdfText/pdfToEpub')).pdfToEpub(data, ctx, options),
  };
}

/** Conversions that run entirely in the browser, the tools' own and plugins' (`registerConverters`). Their libraries load on first use. */
export const CONVERTERS: Converter[] = [
  {
    id: 'kindle-epub',
    from: ['mobi', 'azw3', 'azw'],
    to: 'epub',
    version: '1',
    fidelity: 0.95,
    run: async (data, _from, ctx) => (await import('../kindle')).kindleToEpub(data, ctx),
  },
  {
    id: 'txt-epub',
    from: ['txt'],
    to: 'epub',
    version: '1',
    fidelity: 1,
    run: async (data, _from, ctx) => (await import('./text')).txtToEpub(data, ctx),
  },
  {
    id: 'rtf-epub',
    from: ['rtf'],
    to: 'epub',
    version: '1',
    fidelity: 0.9,
    run: async (data, _from, ctx) => (await import('./text')).rtfToEpub(data, ctx),
  },
  {
    id: 'comic-epub',
    from: ['cbz', 'cbr'],
    to: 'epub',
    version: '1',
    fidelity: 0.95,
    run: async (data, from, ctx) => (await import('./comics')).comicToEpub(from as 'cbz' | 'cbr', data, ctx),
  },
  {
    id: 'cbr-cbz',
    from: ['cbr'],
    to: 'cbz',
    version: '1',
    fidelity: 1,
    run: async (data, _from, ctx) => (await import('./comics')).cbrToCbz(data, ctx),
  },
  {
    id: 'cbz-cbr',
    from: ['cbz'],
    to: 'cbr',
    version: '1',
    fidelity: 1,
    run: async (data, _from, ctx) => (await import('./comics')).cbzToCbr(data, ctx),
  },
  ...(['azw3', 'mobi', 'azw'] as const).map(
    (to): Converter => ({
      id: `epub-${to}`,
      from: EPUB_FORMATS,
      to,
      version: '1',
      // KF8 keeps the HTML and CSS; MOBI 6 turns the CSS into what its tags can say.
      fidelity: to === 'azw3' ? 0.9 : 0.7,
      run: async (data, _from, ctx) => (await import('../mobi/write')).epubToKindle(data, ctx, to),
    }),
  ),
  pdfConverter(),
  pdfTextConverter(),
  {
    id: 'epub-rtf',
    from: EPUB_FORMATS,
    to: 'rtf',
    version: '1',
    fidelity: 0.6,
    run: async (data, _from, ctx) => (await import('./rtf')).epubToRtf(data, ctx),
  },
  {
    id: 'epub-txt',
    from: EPUB_FORMATS,
    to: 'txt',
    version: '1',
    fidelity: 0.1,
    run: async (data, _from, ctx) => (await import('./text')).epubToTxt(data, ctx),
  },
];

/** The formats conversions make, in the order they're first listed. */
export const CONVERSION_TARGETS: FormatId[] = [...new Set(CONVERTERS.map((c) => c.to))];

/** Adds a plugin's converters (after its formats, `registerFormats`), each once. */
export function registerConverters(converters: Converter[]) {
  for (const converter of converters) {
    if (CONVERTERS.some((c) => c.id === converter.id)) continue;
    CONVERTERS.push(converter);
    if (!CONVERSION_TARGETS.includes(converter.to)) CONVERSION_TARGETS.push(converter.to);
  }
}

export function convertersFrom(format: string): Converter[] {
  return CONVERTERS.filter((c) => (c.from as string[]).includes(format));
}

/** What a path of conversions keeps: the product of its steps' fidelities, each keeping a share of what the one before kept. Everything for none. */
export const pathFidelity = (path: Converter[]) => path.reduce((kept, c) => kept * c.fidelity, 1);

const EPSILON = 1e-9;

/** Whether one path is better than another: it keeps more, or as much in fewer conversions. */
export function betterPath(a: Converter[], b: Converter[]): boolean {
  const difference = pathFidelity(a) - pathFidelity(b);
  return difference > EPSILON || (Math.abs(difference) <= EPSILON && a.length < b.length);
}

/**
 * Every format a format converts to, each by the path that loses least (as little in fewer conversions:
 * EPUB to X4 EPUB directly, MOBI by way of EPUB), the best first. Plain text keeps only the words, so a path
 * through it loses nearly everything and is taken only where there's no other.
 */
export function conversionPaths(from: string): Map<FormatId, Converter[]> {
  const best = new Map<string, Converter[]>([[from, []]]);
  const done = new Set<string>();
  // Dijkstra's: what a path keeps only shrinks as it grows, so the best open format can't be bettered.
  for (;;) {
    let format: string | undefined;
    for (const [f, path] of best) if (!done.has(f) && (format === undefined || betterPath(path, best.get(format)!))) format = f;
    if (format === undefined) break;
    done.add(format);
    for (const converter of convertersFrom(format)) {
      const path = [...best.get(format)!, converter];
      const known = best.get(converter.to);
      if (!done.has(converter.to) && (!known || betterPath(path, known))) best.set(converter.to, path);
    }
  }
  best.delete(from);
  return new Map([...best].sort(([, a], [, b]) => (betterPath(a, b) ? -1 : betterPath(b, a) ? 1 : 0))) as Map<FormatId, Converter[]>;
}

/** The conversions from one format to another that lose least, if there are any. */
export const conversionPath = (from: string, to: string): Converter[] | undefined => conversionPaths(from).get(to as FormatId);

/** The options of a path's converters, each once (a key two converters share is asked for once). */
export function pathOptions(path: Converter[]): OptionField[] {
  return [...new Map(path.flatMap((c) => c.options ?? []).map((f) => [f.key, f])).values()];
}

/** A path's converters with the options given, by key: each takes those it has. */
export function pathWithOptions(path: Converter[], values: Record<string, string>): Converter[] {
  return path.map((converter) => {
    const own = (converter.options ?? []).filter((f) => f.key in values);
    if (!own.length || !converter.withOptions) return converter;
    return converter.withOptions(Object.fromEntries(own.map((f) => [f.key, values[f.key]!])));
  });
}
