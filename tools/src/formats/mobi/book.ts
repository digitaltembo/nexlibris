import type { ConvertContext } from '../convert/bookFromItem';
import { bcp47Language } from '../language';
import type { EpubPackage } from './epub';
import { base32, exthNumber, exthText, type ExthRecord } from './records';
import { deobfuscateFont, fontRecord, isFont, kindleImage, thumbnail, type ImageType } from './resources';

/** What MOBI 6 and KF8 books both take from the library and the EPUB: metadata, and resource records. */

/** EXTH record types. */
export const EXTH = {
  author: 100,
  publisher: 101,
  description: 103,
  isbn: 104,
  subject: 105,
  published: 106,
  asin: 113,
  startReading: 116,
  kf8Boundary: 121,
  resourceCount: 125,
  kf8CoverUri: 129,
  kf8UnknownCount: 131,
  coverOffset: 201,
  thumbnailOffset: 202,
  fakeCover: 203,
  creatorSoftware: 204,
  creatorMajor: 205,
  creatorMinor: 206,
  creatorBuild: 207,
  documentType: 501,
  title: 503,
  language: 524,
  writingMode: 525,
  pageDirection: 527,
  overrideFonts: 528,
  creatorBuildTag: 535,
} as const;

/** The book's metadata as EXTH records, from the library's record of it (as every conversion takes it). */
export function metadataRecords({ item }: ConvertContext): ExthRecord[] {
  const text = (key: string) => (typeof item.metadata[key] === 'string' ? (item.metadata[key] as string).trim() : undefined);
  const records: ExthRecord[] = [];
  for (const c of item.creators) if (c.role === 'aut') records.push(exthText(EXTH.author, c.name));
  const publisher = text('publisher');
  if (publisher) records.push(exthText(EXTH.publisher, publisher));
  const description = text('description');
  if (description) records.push(exthText(EXTH.description, description));
  if (item.identifiers.isbn) records.push(exthText(EXTH.isbn, item.identifiers.isbn));
  for (const tag of item.tags) records.push(exthText(EXTH.subject, tag));
  const published = text('published');
  if (published && !published.startsWith('-')) records.push(exthText(EXTH.published, published));
  records.push(exthText(EXTH.title, item.title.trim() || 'Untitled'));
  const language = text('language');
  if (language) records.push(exthText(EXTH.language, bcp47Language(language)));
  // An ASIN, and the personal-document type, are what let a Kindle show a side-loaded book's
  // cover; Calibre writes the book's UUID as one, as does this.
  const asin = item.identifiers.amazon ?? item.identifiers.asin ?? item.identifiers['mobi-asin'] ?? item.identifiers.uuid ?? crypto.randomUUID();
  records.push(exthText(EXTH.asin, asin), exthText(EXTH.documentType, 'EBOK'));
  return records;
}

/** Windows' primary language ids, which the MOBI header gives the book's language as. */
const LANGUAGE_IDS: Record<string, number> = {
  ar: 0x01, bg: 0x02, ca: 0x03, zh: 0x04, cs: 0x05, da: 0x06, de: 0x07, el: 0x08, en: 0x09, es: 0x0a, fi: 0x0b,
  fr: 0x0c, he: 0x0d, hu: 0x0e, is: 0x0f, it: 0x10, ja: 0x11, ko: 0x12, nl: 0x13, no: 0x14, nb: 0x14, nn: 0x14,
  pl: 0x15, pt: 0x16, rm: 0x17, ro: 0x18, ru: 0x19, hr: 0x1a, sk: 0x1b, sq: 0x1c, sv: 0x1d, th: 0x1e, tr: 0x1f,
  ur: 0x20, id: 0x21, uk: 0x22, be: 0x23, sl: 0x24, et: 0x25, lv: 0x26, lt: 0x27, fa: 0x29, vi: 0x2a, hy: 0x2b,
  az: 0x2c, eu: 0x2d, mk: 0x2f, st: 0x30, ts: 0x31, tn: 0x32, af: 0x36, ka: 0x37, fo: 0x38, hi: 0x39, mt: 0x3a,
  se: 0x3b, ms: 0x3e, kk: 0x3f, sw: 0x41, uz: 0x43, tt: 0x44, bn: 0x45, pa: 0x46, gu: 0x47, or: 0x48, ta: 0x49,
  te: 0x4a, kn: 0x4b, ml: 0x4c, as: 0x4d, mr: 0x4e, sa: 0x4f, kok: 0x57, ne: 0x61,
};

export function languageCode(language: string | undefined): number {
  const primary = language ? bcp47Language(language).split('-')[0]!.toLowerCase() : '';
  return LANGUAGE_IDS[primary] ?? 0;
}

/** Records naming the software that made the file, as kindlegen's (KF8: 2.9; MOBI 6: 1.2), which Kindles read the file by. */
export function creatorRecords(kf8: boolean): ExthRecord[] {
  const values = kf8 ? [201, 2, 9, 0] : [201, 1, 2, 33307];
  const records = [EXTH.creatorSoftware, EXTH.creatorMajor, EXTH.creatorMinor, EXTH.creatorBuild].map((type, i) => exthNumber(type, values[i]!));
  if (kf8) records.push(exthText(EXTH.creatorBuildTag, '0730-890adc2'));
  return records;
}

export interface Resources {
  /** The resource records, in order: the cover and its thumbnail first, then images, then fonts. */
  records: Uint8Array[];
  /** Each image's record number from the first resource (1 the first) and type, by its path in the EPUB. */
  images: Map<string, { index: number; type: ImageType }>;
  /** Each font's record number, by path. */
  fonts: Map<string, number>;
  /** The cover's and thumbnail's offsets from the first resource (0 the first). */
  coverOffset?: number;
  thumbnailOffset?: number;
}

/** A key for the library's own cover, which isn't one of the EPUB's files. */
export const LIBRARY_COVER = '\0cover';

/**
 * The records for the images and fonts the book uses: the cover (the library's, else the
 * EPUB's) and a thumbnail of it first, as Kindles find them by offset, then the rest in the
 * order given. Images a Kindle can't show, and fonts that aren't TrueType or OpenType, are left out.
 */
export async function gatherResources(
  pkg: EpubPackage,
  ctx: ConvertContext,
  imagePaths: Iterable<string>,
  fontPaths: Iterable<string> = [],
): Promise<Resources> {
  const out: Resources = { records: [], images: new Map(), fonts: new Map() };
  const add = (path: string, image: { data: Uint8Array; type: ImageType }) => {
    out.records.push(image.data);
    out.images.set(path, { index: out.records.length, type: image.type });
  };

  const coverPath = ctx.cover ? LIBRARY_COVER : pkg.cover;
  const coverBytes = ctx.cover ? new Uint8Array(await ctx.cover.data.arrayBuffer()) : coverPath && (await pkg.read(coverPath));
  const cover = coverBytes && (await kindleImage(coverBytes, ctx.cover?.mediaType ?? pkg.byPath.get(coverPath!)?.mediaType ?? ''));
  if (coverPath && cover) {
    add(coverPath, cover);
    out.coverOffset = 0;
    const thumb = await thumbnail(cover.data);
    if (thumb) {
      out.records.push(thumb);
      out.thumbnailOffset = 1;
    }
  }
  for (const path of imagePaths) {
    if (out.images.has(path)) continue;
    const bytes = await pkg.read(path);
    const image = bytes && (await kindleImage(bytes, pkg.byPath.get(path)?.mediaType ?? ''));
    if (image) add(path, image);
  }
  for (const path of fontPaths) {
    if (out.fonts.has(path)) continue;
    let bytes: Uint8Array | undefined = await pkg.read(path);
    if (!bytes) continue;
    const algorithm = pkg.obfuscated.get(path);
    if (algorithm && pkg.identifier) bytes = await deobfuscateFont(bytes, algorithm, pkg.identifier);
    if (!isFont(bytes)) continue;
    out.records.push(await fontRecord(bytes));
    out.fonts.set(path, out.records.length);
  }
  return out;
}

/** The EXTH records saying where the cover and thumbnail are. */
export function coverRecords(resources: Resources, kf8: boolean): ExthRecord[] {
  const records: ExthRecord[] = [];
  if (resources.coverOffset !== undefined) {
    records.push(exthNumber(EXTH.coverOffset, resources.coverOffset), exthNumber(EXTH.fakeCover, 0));
    if (kf8) records.push(exthText(EXTH.kf8CoverUri, `kindle:embed:${base32(resources.coverOffset + 1, 4)}`));
  }
  if (resources.thumbnailOffset !== undefined) records.push(exthNumber(EXTH.thumbnailOffset, resources.thumbnailOffset));
  return records;
}
