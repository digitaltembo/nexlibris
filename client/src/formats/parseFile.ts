import { parseEpub } from './epub';
import type { FormatId, ParsedItem } from './formats';

/** Reads library metadata out of a file. Heavy format libraries load on first use. */
export async function parseFile(format: FormatId, data: Blob, filename: string): Promise<ParsedItem> {
  switch (format) {
    case 'epub':
    case 'x4.epub':
    case 'x3.epub':
      return parseEpub(data, filename);
    case 'pdf':
      return (await import('./pdf')).parsePdf(data, filename);
    case 'cbz':
    case 'cbr':
      return (await import('./comic')).parseComic(format, data, filename);
    case 'txt':
      return (await import('./text')).parseText(data, filename);
    case 'rtf':
      return (await import('./text')).parseRtf(data, filename);
    case 'mobi':
    case 'azw3':
    case 'azw':
      return (await import('./kindle')).parseKindle(data, filename);
  }
}
