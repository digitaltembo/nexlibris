import { parseEpub } from './epub';
import { emptyParsedItem, isEpub, type FormatId, type ParsedItem } from './formats';

/** Reads library metadata out of a file. Heavy format libraries load on first use. */
export async function parseFile(format: FormatId, data: Blob, filename: string): Promise<ParsedItem> {
  if (isEpub(format)) return parseEpub(data, filename);
  switch (format) {
    case 'pdf':
      return (await import('./pdf')).parsePdf(data, filename);
    case 'cbz':
    case 'cbr':
      return (await import('./comic')).parseComic(format, data, filename);
    case 'cb7':
      // No 7-Zip reader in the tools: the name only, no cover or ComicInfo.xml. epubier reads it.
      return emptyParsedItem(filename);
    case 'txt':
      return (await import('./text')).parseText(data, filename);
    case 'rtf':
      return (await import('./text')).parseRtf(data, filename);
    case 'mobi':
    case 'azw3':
    case 'azw':
      return (await import('./kindle')).parseKindle(data, filename);
    default:
      throw new Error(`nexlibris can’t read ${format} files.`);
  }
}
