import { mergeTags, type BookMetadata, type Creator } from '../metadata';

type BaseFormatId = 'epub' | 'pdf' | 'cbz' | 'cbr' | 'txt' | 'rtf' | 'mobi' | 'azw3' | 'azw';

/**
 * The formats plugins add, by id (`x4.epub`, say). A plugin's package names its formats here by
 * declaration merging, `declare module '@nexlibris/tools/formats/formats' { interface PluginFormats
 * { 'x4.epub': true } }`, and the app registers them (`registerFormats`) before using any of this.
 */
export interface PluginFormats {}

/** A format the tools know: their own, and those plugins add. */
export type FormatId = BaseFormatId | keyof PluginFormats;

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

/** Every format known, plugins' included once registered. */
export const FORMATS = { ...BASE_FORMATS } as Record<FormatId, FormatInfo>;

export function isFormatId(format: string): format is FormatId {
  return format in FORMATS;
}

/** Whether a format is an EPUB: `epub`, or one made for a particular reader (`x4.epub`). */
export const isEpub = (format: string) => format === 'epub' || (isFormatId(format) && !!FORMATS[format].epub);

/** The EPUBs: `epub` first, then plugins' (the formats whose metadata nexlibris can write). */
export const EPUB_FORMATS: FormatId[] = [];

/** Readers' EPUBs, made from an EPUB by a plugin's converter: every EPUB but `epub` itself. */
export const READER_EPUBS: FormatId[] = [];

/** Formats that are Kindle/Mobipocket files, read by converting to EPUB. */
export const KINDLE_FORMATS: FormatId[] = ['mobi', 'azw3', 'azw'];

/** When an item has several files, the one opened by "Read", best first. */
export const READ_PREFERENCE: FormatId[] = [];

/** For `<input accept>`. */
export const IMPORT_ACCEPT = '.epub,.pdf,.cbz,.cbr,.txt,.rtf,.mobi,.azw3,.azw';

/** Extensions of more than one part (`x4.epub`), longest first, which a file's name is checked for before its last one. */
const COMPOUND: FormatId[] = [];

/** The lists above, from the formats known. They're filled in place, so they stay the same arrays. */
function derive() {
  const ids = Object.keys(FORMATS) as FormatId[];
  const fill = (list: FormatId[], formats: FormatId[]) => list.splice(0, list.length, ...formats);
  fill(EPUB_FORMATS, ids.filter(isEpub));
  fill(READER_EPUBS, EPUB_FORMATS.filter((format) => format !== 'epub'));
  fill(READ_PREFERENCE, [...EPUB_FORMATS, 'pdf', 'cbz', 'cbr', 'rtf', 'txt']);
  fill(COMPOUND, ids.filter((f) => f.includes('.')).sort((a, b) => b.length - a.length));
}
derive();

/**
 * Adds a plugin's formats. Call it before anything reads the formats (at each entry point: a page, a
 * worker, test setup), as lists taken from them when a module loads won't see formats added later.
 */
export function registerFormats(formats: Record<string, FormatInfo>) {
  Object.assign(FORMATS, formats);
  derive();
}

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
  cover?: { data: Blob; mediaType: string };
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
