import type { EpubMetadata } from './epubMetadata';
import { bcp47Language, sameLanguage } from './language';
import { KindleError, readKindleHeader } from './kindleHeader';

/**
 * Writing metadata into a Kindle file (MOBI, AZW, AZW3) without touching its text, as Calibre's
 * `ebook-meta` does: each MOBI header record is rebuilt with new EXTH records and full name, within
 * the padding the record already has where it fits (kindlegen and Calibre leave several kilobytes),
 * else with every later record moved along. A joint file, an old MOBI with a KF8 book after it,
 * has a header record for each half (the KF8 one named by EXTH 121), and both are rewritten.
 */

/** EXTH record types written; any others (ASIN, document type, cover offsets, the KF8 boundary) are kept. */
const EXTH = { author: 100, publisher: 101, description: 103, subject: 105, published: 106, title: 503, language: 524 } as const;

/** Room left in a record that had to grow, so the next edit fits without moving the rest again. */
const SLACK = 1024;

/** Windows-1252's characters at 0x80–0x9F; the rest of its range is Latin-1's. */
const CP1252_HIGH = '€\u0081‚ƒ„…†‡ˆ‰Š‹Œ\u008dŽ\u008f\u0090‘’“”•–—˜™š›œ\u009džŸ';

/** Text in the file's encoding: UTF-8 (65001), or Windows-1252 (1252) with `?` for what it lacks. */
function encoderFor(encoding: number): (text: string) => Uint8Array {
  if (encoding !== 1252) return (text) => new TextEncoder().encode(text);
  return (text) =>
    Uint8Array.from(text, (char) => {
      const code = char.codePointAt(0)!;
      const high = CP1252_HIGH.indexOf(char);
      return high >= 0 ? 0x80 + high : code < 0x80 || (code >= 0xa0 && code <= 0xff) ? code : 0x3f;
    });
}

/** A date EXTH 106 can hold, as EPUB's can: none before AD 1. */
const writableDate = (date: string | undefined) => (date && !date.startsWith('-') ? date : undefined);

interface ExthRecord {
  type: number;
  data: Uint8Array;
}

/** Concatenates byte arrays. */
function join(parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

const u32 = (n: number) => {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, n);
  return bytes;
};

/**
 * A MOBI header record with the book's metadata written in: what `book` says replaces what the
 * record says, and what it lacks (no description, no tags) is left as it was. Its length is the
 * old record's if that's room enough.
 */
function rewriteHeaderRecord(record: Uint8Array, book: EpubMetadata): Uint8Array<ArrayBuffer> {
  const view = new DataView(record.buffer, record.byteOffset, record.byteLength);
  const headerEnd = 16 + view.getUint32(20);
  const flags = view.getUint32(128);
  const nameStart = view.getUint32(84);
  const nameEnd = nameStart + view.getUint32(88);
  const encode = encoderFor(view.getUint32(28));
  const decoder = new TextDecoder(view.getUint32(28) === 1252 ? 'windows-1252' : 'utf-8');

  const old: ExthRecord[] = [];
  let exthEnd = headerEnd;
  if (flags & 0x40 && String.fromCharCode(...record.subarray(headerEnd, headerEnd + 4)) === 'EXTH') {
    const count = view.getUint32(headerEnd + 8);
    let at = headerEnd + 12;
    for (let i = 0; i < count; i++) {
      const length = at + 8 <= record.length ? view.getUint32(at + 4) : 0;
      if (length < 8 || at + length > record.length) throw new KindleError('Its metadata (EXTH) is damaged.');
      old.push({ type: view.getUint32(at), data: record.subarray(at + 8, at + length) });
      at += length;
    }
    exthEnd = at;
  }
  // After the metadata come the full name and padding, and nothing else this could overwrite.
  if (nameStart < exthEnd || nameEnd > record.length) throw new KindleError('Its header is laid out in a way this can’t rewrite.');
  const stray = (from: number, to: number) => record.subarray(from, to).some((b) => b !== 0);
  if (stray(exthEnd, nameStart) || stray(nameEnd, record.length)) throw new KindleError('Its header is laid out in a way this can’t rewrite.');

  const oldLanguage = old.find((r) => r.type === EXTH.language);
  const language = book.language && !(oldLanguage && sameLanguage(decoder.decode(oldLanguage.data), book.language)) ? bcp47Language(book.language) : undefined;
  const published = writableDate(book.published);
  const authors = book.creators.filter((c) => c.role === 'aut').map((c) => c.name);
  const values = new Map<number, string[]>([[EXTH.title, [book.title]]]);
  if (authors.length) values.set(EXTH.author, authors);
  if (book.publisher) values.set(EXTH.publisher, [book.publisher]);
  if (book.description) values.set(EXTH.description, [book.description]);
  if (book.tags?.length) values.set(EXTH.subject, book.tags);
  if (published) values.set(EXTH.published, [published]);
  if (language) values.set(EXTH.language, [language]);

  // Each type replaced where it first was, so the rest keep their order; new types go at the end.
  const records: ExthRecord[] = [];
  const written = new Set<number>();
  const write = (type: number) => {
    written.add(type);
    for (const value of values.get(type)!) records.push({ type, data: encode(value) });
  };
  for (const record of old) {
    if (!values.has(record.type)) records.push(record);
    else if (!written.has(record.type)) write(record.type);
  }
  for (const type of values.keys()) if (!written.has(type)) write(type);

  const exthLength = 12 + records.reduce((n, r) => n + 8 + r.data.length, 0);
  const exth = join([
    new TextEncoder().encode('EXTH'),
    u32(exthLength),
    u32(records.length),
    ...records.flatMap((r) => [u32(r.type), u32(8 + r.data.length), r.data]),
    new Uint8Array((4 - (exthLength % 4)) % 4),
  ]);
  const name = encode(book.title);
  // The name is followed by at least two zero bytes, then padded to four, as kindlegen writes it.
  const used = headerEnd + exth.length + name.length;
  const needed = used + 2 + ((4 - ((used + 2) % 4)) % 4);
  const length = needed <= record.length ? record.length : needed + SLACK;

  const out = new Uint8Array(length);
  out.set(record.subarray(0, headerEnd));
  out.set(exth, headerEnd);
  out.set(name, headerEnd + exth.length);
  const header = new DataView(out.buffer);
  header.setUint32(84, headerEnd + exth.length);
  header.setUint32(88, name.length);
  header.setUint32(128, flags | 0x40);
  return out;
}

/**
 * Rewrites a Kindle file's metadata from the library's, as `writeEpubMetadata` does an EPUB's:
 * title, authors, publisher, description, tags, publication date and language. What the library
 * has replaces what the file says; what it lacks is left as the file has it, as is everything
 * else: identifiers (ISBN, ASIN), the cover, and the text. Kindle files have no place for series
 * or sort names, so those aren't written. Throws `KindleError` for a file with DRM or one it can't
 * safely rewrite.
 */
export async function writeKindleMetadata(data: Blob, book: EpubMetadata): Promise<Blob> {
  const bytes = new Uint8Array(await data.arrayBuffer());
  let header;
  try {
    header = readKindleHeader(bytes);
  } catch (e) {
    throw new KindleError(`Not a readable MOBI/AZW file: ${e instanceof Error ? e.message : e}`);
  }
  if (header.encrypted) throw new KindleError('This book is DRM-protected, so it can’t be rewritten.');

  const view = new DataView(bytes.buffer);
  const count = view.getUint16(76);
  const starts = Array.from({ length: count }, (_, i) => view.getUint32(78 + i * 8));
  const end = (index: number) => (index + 1 < count ? starts[index + 1]! : bytes.length);
  const record = (index: number) => bytes.subarray(starts[index]!, end(index));
  const isMobiHeader = (index: number) => index < count && String.fromCharCode(...record(index).subarray(16, 20)) === 'MOBI';

  const replaced = new Map<number, Uint8Array<ArrayBuffer>>([[0, rewriteHeaderRecord(record(0), book)]]);
  const boundary = header.kf8HeaderRecord;
  if (boundary !== undefined && boundary !== 0) {
    if (!isMobiHeader(boundary)) throw new KindleError('Its KF8 header isn’t where the file says it is.');
    replaced.set(boundary, rewriteHeaderRecord(record(boundary), book));
  }

  // Where every record fits where it was, the file stays the same size with its records in place.
  const out = new Uint8Array(bytes.length + [...replaced].reduce((n, [index, r]) => n + r.length - record(index).length, 0));
  const offsets = new DataView(out.buffer);
  out.set(bytes.subarray(0, starts[0]));
  let at = starts[0]!;
  for (let index = 0; index < count; index++) {
    const data = replaced.get(index) ?? record(index);
    offsets.setUint32(78 + index * 8, at);
    out.set(data, at);
    at += data.length;
  }
  return new Blob([out], { type: data.type });
}
