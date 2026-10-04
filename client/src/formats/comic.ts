import type { Creator } from '@nexlibris/common';
import JSZip from 'jszip';
import { emptyParsedItem, splitTags, type ParsedItem } from './formats';
import { parseXml } from './xml';

export interface ComicPage {
  name: string;
  mediaType: string;
  load(): Promise<Blob>;
}

export interface Comic {
  pages: ComicPage[];
  comicInfo?: string;
}

export class ComicError extends Error {
  name = 'ComicError';
}

const IMAGE_TYPES: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  bmp: 'image/bmp',
};

function imageType(name: string): string | undefined {
  const base = name.split('/').pop() ?? '';
  if (base.startsWith('.') || name.startsWith('__MACOSX/')) return undefined;
  return IMAGE_TYPES[base.split('.').pop()?.toLowerCase() ?? ''];
}

const byPageOrder = (a: { name: string }, b: { name: string }) =>
  a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });

export interface ComicOptions {
  /** unrar's WebAssembly binary; fetched from the bundled asset when omitted. */
  unrarWasm?: ArrayBuffer;
}

/** Reads a CBZ or CBR into its pages (images in reading order) and ComicInfo.xml. */
export async function openComic(format: 'cbz' | 'cbr', data: Blob, options: ComicOptions = {}): Promise<Comic> {
  return format === 'cbz' ? openCbz(data) : openCbr(data, options);
}

async function openCbz(data: Blob): Promise<Comic> {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(await data.arrayBuffer());
  } catch {
    throw new ComicError('Not a valid CBZ (not a zip archive)');
  }
  const pages = Object.values(zip.files)
    .filter((f) => !f.dir && imageType(f.name))
    .map((f) => {
      const mediaType = imageType(f.name)!;
      return { name: f.name, mediaType, load: async () => new Blob([await f.async('blob')], { type: mediaType }) };
    })
    .sort(byPageOrder);
  const infoFile = Object.values(zip.files).find((f) => /(^|\/)comicinfo\.xml$/i.test(f.name));
  return { pages, ...(infoFile && { comicInfo: await infoFile.async('string') }) };
}

async function loadUnrarWasm(): Promise<ArrayBuffer> {
  const { default: url } = await import('node-unrar-js/esm/js/unrar.wasm?url');
  return (await fetch(url)).arrayBuffer();
}

async function openCbr(data: Blob, options: ComicOptions): Promise<Comic> {
  const { createExtractorFromData } = await import('node-unrar-js');
  const wasmBinary = options.unrarWasm ?? (await loadUnrarWasm());
  let files: { name: string; data: Uint8Array }[];
  try {
    const extractor = await createExtractorFromData({ wasmBinary, data: await data.arrayBuffer() });
    // RAR archives are often solid, so everything is extracted in one pass.
    files = [...extractor.extract().files].flatMap((f) =>
      f.fileHeader.flags.directory || !f.extraction ? [] : [{ name: f.fileHeader.name, data: f.extraction }],
    );
  } catch (e) {
    throw new ComicError(`Not a readable CBR: ${e instanceof Error ? e.message : String(e)}`);
  }
  const pages = files
    .filter((f) => imageType(f.name))
    .map((f) => {
      const mediaType = imageType(f.name)!;
      const blob = new Blob([f.data as Uint8Array<ArrayBuffer>], { type: mediaType });
      return { name: f.name, mediaType, load: async () => blob };
    })
    .sort(byPageOrder);
  const info = files.find((f) => /(^|\/)comicinfo\.xml$/i.test(f.name));
  return { pages, ...(info && { comicInfo: new TextDecoder().decode(info.data) }) };
}

const CREATOR_ROLES: [field: string, role: string][] = [
  ['Writer', 'aut'],
  ['Penciller', 'art'],
  ['Inker', 'art'],
  ['Colorist', 'clr'],
  ['Letterer', 'ill'],
  ['CoverArtist', 'cov'],
  ['Editor', 'edt'],
  ['Translator', 'trl'],
];

/** Library metadata from a comic's ComicInfo.xml (if any), with its first page as the cover. */
export async function parseComic(
  format: 'cbz' | 'cbr',
  data: Blob,
  filename: string,
  options: ComicOptions = {},
): Promise<ParsedItem> {
  const comic = await openComic(format, data, options);
  if (comic.pages.length === 0) throw new ComicError(`${filename} contains no images`);
  const parsed = emptyParsedItem(filename);
  const first = comic.pages[0]!;
  parsed.cover = { data: await first.load(), mediaType: first.mediaType };
  if (comic.comicInfo) applyComicInfo(parsed, comic.comicInfo);
  return parsed;
}

export function applyComicInfo(parsed: ParsedItem, xml: string): void {
  const doc = parseXml(xml);
  if (!doc) return;
  const field = (name: string) => doc.getElementsByTagName(name)[0]?.textContent?.trim() || undefined;
  const list = (name: string) => field(name)?.split(',').map((s) => s.trim()).filter(Boolean) ?? [];

  const series = field('Series');
  const number = field('Number');
  parsed.title = field('Title') ?? (series ? `${series}${number ? ` #${number}` : ''}` : parsed.title);

  const seen = new Set<string>();
  parsed.creators = CREATOR_ROLES.flatMap(([name, role]): Creator[] =>
    list(name).flatMap((person) => {
      const key = `${person}|${role}`;
      if (seen.has(key)) return [];
      seen.add(key);
      return [{ name: person, role }];
    }),
  );
  parsed.tags = splitTags([field('Genre') ?? '', field('Tags') ?? '']);

  const set = (key: string, value: string | number | undefined) => {
    if (value !== undefined && value !== '') parsed.metadata[key] = value;
  };
  set('series', series);
  // A number that isn't one ("Annual 1") is the issue, not a place in the series.
  if (number !== undefined) set(Number.isNaN(Number(number)) ? 'issue' : 'seriesIndex', Number.isNaN(Number(number)) ? number : Number(number));
  set('description', field('Summary'));
  set('publisher', field('Publisher'));
  set('language', field('LanguageISO'));
  const year = field('Year');
  const month = field('Month');
  set('published', year && (month ? `${year}-${month.padStart(2, '0')}` : year));
  const gtin = field('GTIN');
  if (gtin) parsed.identifiers.isbn = gtin.replace(/[-\s]/g, '');
}
