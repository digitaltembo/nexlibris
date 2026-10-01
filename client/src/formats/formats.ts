import { mergeTags, type Cover, type Creator, type MetadataValue } from '@nexlibris/common';

export type FormatId = 'epub' | 'x4.epub' | 'x3.epub' | 'pdf' | 'cbz' | 'cbr' | 'txt' | 'rtf' | 'mobi' | 'azw3' | 'azw';

export interface FormatInfo {
  label: string;
  mediaType: string;
}

export const FORMATS: Record<FormatId, FormatInfo> = {
  epub: { label: 'EPUB', mediaType: 'application/epub+zip' },
  'x4.epub': { label: 'EPUB (X4)', mediaType: 'application/epub+zip' },
  'x3.epub': { label: 'EPUB (X3)', mediaType: 'application/epub+zip' },
  pdf: { label: 'PDF', mediaType: 'application/pdf' },
  cbz: { label: 'Comic (CBZ)', mediaType: 'application/vnd.comicbook+zip' },
  cbr: { label: 'Comic (CBR)', mediaType: 'application/vnd.comicbook-rar' },
  txt: { label: 'Text', mediaType: 'text/plain' },
  rtf: { label: 'Rich Text', mediaType: 'application/rtf' },
  mobi: { label: 'MOBI', mediaType: 'application/x-mobipocket-ebook' },
  azw3: { label: 'Kindle (AZW3)', mediaType: 'application/vnd.amazon.ebook' },
  azw: { label: 'Kindle (AZW)', mediaType: 'application/vnd.amazon.ebook' },
};

/** Formats that are Kindle/Mobipocket files, read by converting to EPUB. */
export const KINDLE_FORMATS: FormatId[] = ['mobi', 'azw3', 'azw'];

/** When an item has several files, the one opened by "Read", best first. */
export const READ_PREFERENCE: FormatId[] = ['epub', 'x4.epub', 'x3.epub', 'pdf', 'cbz', 'cbr', 'rtf', 'txt'];

/** For `<input accept>`. */
export const IMPORT_ACCEPT = '.epub,.pdf,.cbz,.cbr,.txt,.rtf,.mobi,.azw3,.azw';

/** The format a filename denotes, recognizing compound extensions like `.x4.epub`. */
export function formatFromName(name: string): FormatId | undefined {
  const match = /\.((?:x[34]\.)?[a-z0-9]+)$/i.exec(name);
  const ext = match?.[1]?.toLowerCase();
  return ext && ext in FORMATS ? (ext as FormatId) : undefined;
}

export function isFormatId(format: string): format is FormatId {
  return format in FORMATS;
}

/** Library metadata read out of a file, before it becomes an item. */
export interface ParsedItem {
  title: string;
  creators: Creator[];
  identifiers: Record<string, string>;
  tags: string[];
  metadata: Record<string, MetadataValue>;
  cover?: { data: Blob; mediaType: Cover['mediaType'] };
}

/**
 * Tags from metadata where one entry may hold several (e.g. a single EPUB
 * `dc:subject` of "Fantasy, Adventure; Magic"): split on commas and semicolons,
 * trimmed and without case-insensitive duplicates.
 */
export function splitTags(values: readonly string[]): string[] {
  return mergeTags([], values.flatMap((v) => v.split(/[,;]/)));
}

export function titleFromFilename(name: string): string {
  return name.replace(/\.(x[34]\.)?[a-z0-9]+$/i, '').replace(/[_]+/g, ' ').trim() || 'Untitled';
}

export function emptyParsedItem(filename: string): ParsedItem {
  return { title: titleFromFilename(filename), creators: [], identifiers: {}, tags: [], metadata: {} };
}
