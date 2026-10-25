import { isEpub, KINDLE_FORMATS, type FormatId } from '@nexlibris/tools/formats/formats';

/** epubier's format for a file's, where epubier reads it (`epubier/all`: ePubs, Kindle books, PDFs, CBZ, CBR and CB7 comics and RTF). */
export function epubierFormat(format: FormatId): 'epub' | 'mobi' | 'pdf' | 'cbz' | 'comicarchive' | 'rtf' | undefined {
  if (isEpub(format)) return 'epub';
  if (KINDLE_FORMATS.includes(format)) return 'mobi';
  if (format === 'pdf') return 'pdf';
  if (format === 'cbz') return 'cbz';
  if (format === 'cbr' || format === 'cb7') return 'comicarchive';
  if (format === 'rtf') return 'rtf';
  return undefined;
}
