import { mergeTags, type BookMetadata, type Cover, type Creator } from '@nexlibris/common';
import { PLUGIN_FORMATS } from '../plugins/formats';

type BaseFormatId = 'epub' | 'pdf' | 'cbz' | 'cbr' | 'txt' | 'rtf' | 'mobi' | 'azw3' | 'azw';

/** A format nexlibris knows: its own, and those plugins add (`plugins/formats.ts`), such as `x4.epub`. */
export type FormatId = BaseFormatId | keyof typeof PLUGIN_FORMATS;

export interface FormatInfo {
  label: string;
  mediaType: string;
  /** An EPUB made for a particular reader (a plugin's, say): read, parsed, indexed and written as an EPUB. */
  epub?: boolean;
}

const BASE_FORMATS: Record<BaseFormatId, FormatInfo> = {
  epub: { label: 'EPUB', mediaType: 'application/epub+zip' },
  pdf: { label: 'PDF', mediaType: 'application/pdf' },
  cbz: { label: 'Comic (CBZ)', mediaType: 'application/vnd.comicbook+zip' },
  cbr: { label: 'Comic (CBR)', mediaType: 'application/vnd.comicbook-rar' },
  txt: { label: 'Text', mediaType: 'text/plain' },
  rtf: { label: 'Rich Text', mediaType: 'application/rtf' },
  mobi: { label: 'MOBI', mediaType: 'application/x-mobipocket-ebook' },
  azw3: { label: 'Kindle (AZW3)', mediaType: 'application/vnd.amazon.ebook' },
  azw: { label: 'Kindle (AZW)', mediaType: 'application/vnd.amazon.ebook' },
};

export const FORMATS: Record<FormatId, FormatInfo> = { ...BASE_FORMATS, ...PLUGIN_FORMATS };

export function isFormatId(format: string): format is FormatId {
  return format in FORMATS;
}

/** Whether a format is an EPUB: `epub`, or one made for a particular reader (`x4.epub`). */
export const isEpub = (format: string) => format === 'epub' || (isFormatId(format) && !!FORMATS[format].epub);

/** The EPUBs: `epub` first, then plugins' (the formats whose metadata nexlibris can write). */
export const EPUB_FORMATS: FormatId[] = (Object.keys(FORMATS) as FormatId[]).filter(isEpub);

/** Readers' EPUBs, made from an EPUB by a plugin's converter: every EPUB but `epub` itself. */
export const READER_EPUBS: FormatId[] = EPUB_FORMATS.filter((format) => format !== 'epub');

/** Formats that are Kindle/Mobipocket files, read by converting to EPUB. */
export const KINDLE_FORMATS: FormatId[] = ['mobi', 'azw3', 'azw'];

/** When an item has several files, the one opened by "Read", best first. */
export const READ_PREFERENCE: FormatId[] = [...EPUB_FORMATS, 'pdf', 'cbz', 'cbr', 'rtf', 'txt'];

/** For `<input accept>`. */
export const IMPORT_ACCEPT = '.epub,.pdf,.cbz,.cbr,.txt,.rtf,.mobi,.azw3,.azw';

/** Extensions of more than one part (`x4.epub`), longest first, which a file's name is checked for before its last one. */
const COMPOUND = (Object.keys(FORMATS) as FormatId[]).filter((f) => f.includes('.')).sort((a, b) => b.length - a.length);

/** A file name's extension as a format would be named: a compound one (`x4.epub`) where it has one, else its last. */
function extensionOf(name: string): string | undefined {
  const lower = name.toLowerCase();
  const compound = COMPOUND.find((format) => lower.endsWith(`.${format}`));
  return compound ?? /\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase();
}

/** The format a filename denotes, recognizing compound extensions like `.x4.epub`. */
export function formatFromName(name: string): FormatId | undefined {
  const ext = extensionOf(name);
  return ext && isFormatId(ext) ? ext : undefined;
}

/** A file name without its extension, a compound one (`.x4.epub`) included. */
export function stripExtension(name: string): string {
  const ext = extensionOf(name);
  return ext ? name.slice(0, name.length - ext.length - 1) : name;
}

/** Library metadata read out of a file, before it becomes an item. */
export interface ParsedItem {
  title: string;
  creators: Creator[];
  identifiers: Record<string, string>;
  tags: string[];
  metadata: BookMetadata;
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
  return stripExtension(name).replace(/[_]+/g, ' ').trim() || 'Untitled';
}

export function emptyParsedItem(filename: string): ParsedItem {
  return { title: titleFromFilename(filename), creators: [], identifiers: {}, tags: [], metadata: {} };
}
