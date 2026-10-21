import { compressPalmDoc } from './palmdoc';

/**
 * The parts of a Kindle file that MOBI 6 and KF8 share: the Palm database the records sit in,
 * text records with their trailing entries, EXTH metadata, and the INDX records that indexes
 * (tables of contents, KF8's skeletons and fragments) are kept in, with their strings (CNCX).
 * Laid out as kindlegen does, which is what Kindles expect; MobileRead's wiki and Calibre's
 * writers describe it.
 */

export const NULL_INDEX = 0xffffffff;
/** Text is split into records of this many bytes before each is compressed. */
export const TEXT_RECORD_SIZE = 4096;
/** Compression in the header: PalmDOC. */
export const PALMDOC = 2;

export const FLIS = Uint8Array.from([
  ...ascii('FLIS'), 0, 0, 0, 8, 0, 0x41, 0, 0, 0, 0, 0, 0, 0xff, 0xff, 0xff, 0xff, 0, 1, 0, 3, 0, 0, 0, 3, 0, 0, 0, 1,
  0xff, 0xff, 0xff, 0xff,
]);
export const EOF_RECORD = Uint8Array.from([0xe9, 0x8e, 0x0d, 0x0a]);

export function ascii(text: string): number[] {
  return Array.from(text, (c) => c.charCodeAt(0));
}

export const u16 = (n: number) => [(n >>> 8) & 0xff, n & 0xff];
export const u32 = (n: number) => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
/** `count` bytes of one value, zeros unless said. */
export const repeat = (count: number, value = 0): number[] => Array.from({ length: count }, () => value);

/** Concatenates byte arrays. */
export function concat(parts: (Uint8Array | number[])[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/** Zero bytes to make `length` a multiple of four. */
export const padTo4 = (length: number) => new Uint8Array((4 - (length % 4)) % 4);
export const align4 = (bytes: Uint8Array) => concat([bytes, padTo4(bytes.length)]);

export const utf8 = (text: string) => new TextEncoder().encode(text);

/**
 * A variable-width integer, seven bits a byte, most significant first. Forward (for reading
 * from the start): the last byte has its high bit set. Backward (trailing entries, read from
 * the end): the first one does.
 */
export function encint(value: number, forward = true): number[] {
  const bytes: number[] = [];
  do {
    bytes.unshift(value & 0x7f);
    value = Math.floor(value / 128);
  } while (value > 0);
  bytes[forward ? bytes.length - 1 : 0]! |= 0x80;
  return bytes;
}

/** A number in base 32 (`0`–`9`, `A`–`V`), padded with zeros to `digits`, as KF8 writes record and position numbers. */
export function base32(value: number, digits = 0): string {
  return value.toString(32).toUpperCase().padStart(digits, '0');
}

/** A trailing entry: its data, then its whole length as a backward integer. */
export function trailingEntry(data: number[] | Uint8Array): number[] {
  let size = 1;
  while (encint(data.length + size, false).length !== size) size++;
  return [...data, ...encint(data.length + size, false)];
}

export interface TextRecords {
  records: Uint8Array<ArrayBuffer>[];
  /** Each record's text before compression, for trailing index entries. */
  lengths: number[];
}

/**
 * The text in records of 4096 bytes, each compressed, followed by the bytes that complete a
 * character it cuts off (a trailing entry whose last byte counts them, extra-data flag 1).
 */
export function textRecords(text: Uint8Array): TextRecords {
  const records: Uint8Array<ArrayBuffer>[] = [];
  const lengths: number[] = [];
  for (let start = 0; start < text.length; start += TEXT_RECORD_SIZE) {
    const end = Math.min(start + TEXT_RECORD_SIZE, text.length);
    // UTF-8 continuation bytes after the record's end belong to the character it ends in.
    let overlap = end;
    if (end < text.length) {
      let lead = end - 1;
      while (lead > start && (text[lead]! & 0xc0) === 0x80) lead--;
      const byte = text[lead]!;
      const length = byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : byte >= 0xc0 ? 2 : 1;
      overlap = Math.max(end, Math.min(lead + length, text.length));
    }
    const extra = text.subarray(end, overlap);
    records.push(concat([compressPalmDoc(text.subarray(start, end)), extra, [extra.length]]));
    lengths.push(end - start);
  }
  return { records, lengths };
}

/** EXTH metadata records, by type: text, or a number (four bytes). */
export type ExthRecord = { type: number; data: Uint8Array };

export const exthText = (type: number, text: string): ExthRecord => ({ type, data: utf8(text) });
export const exthNumber = (type: number, value: number): ExthRecord => ({ type, data: Uint8Array.from(u32(value)) });

/** The EXTH block: its header and records, then one to four zero bytes to a multiple of four (its length leaves them out), as kindlegen pads it. */
export function exthBlock(records: ExthRecord[]): Uint8Array<ArrayBuffer> {
  const length = 12 + records.reduce((n, r) => n + 8 + r.data.length, 0);
  return concat([
    ascii('EXTH'),
    u32(length),
    u32(records.length),
    ...records.flatMap((r) => [u32(r.type), u32(8 + r.data.length), r.data]),
    new Uint8Array(4 - (length % 4)),
  ]);
}

/** A Palm database name: ASCII, underscores for spaces, at most 31 characters. */
function databaseName(title: string): number[] {
  const name = title
    .normalize('NFKD')
    .replace(/[^\x20-\x7e]/g, '')
    .replace(/ /g, '_')
    .slice(0, 31);
  return [...ascii(name || 'Untitled'), ...repeat(32 - (name || 'Untitled').length)];
}

/** The records as a Palm database of type `BOOKMOBI`, as every Kindle file is. */
export function palmDatabase(title: string, records: Uint8Array[], modified = new Date()): Blob {
  const time = Math.floor(modified.getTime() / 1000);
  const header: number[] = [
    ...databaseName(title),
    ...u16(0),
    ...u16(0),
    ...u32(time),
    ...u32(time),
    ...u32(0),
    ...u32(0),
    ...u32(0),
    ...u32(0),
    ...ascii('BOOKMOBI'),
    ...u32(2 * records.length - 1),
    ...u32(0),
    ...u16(records.length),
  ];
  let offset = header.length + 8 * records.length + 2;
  for (const [i, record] of records.entries()) {
    header.push(...u32(offset), 0, ...u32(2 * i).slice(1));
    offset += record.length;
  }
  header.push(0, 0);
  return new Blob([Uint8Array.from(header), ...(records as Uint8Array<ArrayBuffer>[])], { type: 'application/x-mobipocket-ebook' });
}

/**
 * Strings for an index, in records of their own (CNCX): each its length then UTF-8, found by
 * its offset, which counts 0x10000 for each record before its own.
 */
export class Strings {
  readonly records: Uint8Array<ArrayBuffer>[] = [];
  readonly #offsets = new Map<string, number>();

  constructor(strings: Iterable<string>) {
    let record: number[] = [];
    let offset = 0;
    for (const string of strings) {
      if (this.#offsets.has(string)) continue;
      const bytes = utf8(string.slice(0, 500));
      const entry = [...encint(bytes.length), ...bytes];
      if (record.length + entry.length > 0x10000 - 1024) {
        this.records.push(align4(Uint8Array.from(record)));
        record = [];
        offset = this.records.length * 0x10000;
      }
      this.#offsets.set(string, offset);
      record.push(...entry);
      offset += entry.length;
    }
    if (record.length) this.records.push(align4(Uint8Array.from(record)));
  }

  offset(string: string): number {
    return this.#offsets.get(string)!;
  }
}

/** A tag in an index's table (TAGX): its number, values per entry, and the bits of the control byte that count them. */
export interface IndexTag {
  name: string;
  number: number;
  valuesPerEntry: number;
  mask: number;
}

/** An index entry: its name (written as given), and each tag's values. */
export interface IndexEntry {
  name: string;
  values: Record<string, number | number[]>;
}

const HEADER_LENGTH = 192;
/** Room an index record keeps free, as kindlegen does. */
const RECORD_LIMIT = 0x10000 - HEADER_LENGTH - 1048;

const shiftFor = (mask: number) => {
  let shift = 0;
  while (!((mask >> shift) & 1)) shift++;
  return shift;
};

/**
 * An index: its header record (the tag table and where each record's entries end), its
 * records of entries, then its strings' records. One control byte per entry says how many of
 * each tag's values follow.
 */
export function indexRecords(tags: IndexTag[], entries: IndexEntry[], strings?: Strings): Uint8Array<ArrayBuffer>[] {
  const blocks: { entries: number[]; offsets: number[]; last: number[] }[] = [{ entries: [], offsets: [], last: [] }];
  for (const entry of entries) {
    const name = utf8(entry.name);
    let control = 0;
    const values: number[] = [];
    for (const tag of tags) {
      const value = entry.values[tag.name];
      if (value === undefined) continue;
      const list = typeof value === 'number' ? [value] : value;
      control |= tag.mask & ((list.length / tag.valuesPerEntry) << shiftFor(tag.mask));
      for (const v of list) values.push(...encint(v));
    }
    const bytes = [name.length, ...name, control, ...values];
    let block = blocks.at(-1)!;
    if (block.entries.length + 2 * block.offsets.length + bytes.length + 2 > RECORD_LIMIT) {
      block = { entries: [], offsets: [], last: [] };
      blocks.push(block);
    }
    block.offsets.push(HEADER_LENGTH + block.entries.length);
    block.entries.push(...bytes);
    block.last = [name.length, ...name];
  }

  const records = blocks.map((block) => {
    const body = align4(Uint8Array.from(block.entries));
    const idxt = align4(Uint8Array.from([...ascii('IDXT'), ...block.offsets.flatMap(u16)]));
    const header = [
      ...ascii('INDX'),
      ...u32(HEADER_LENGTH),
      ...u32(0),
      ...u32(1),
      ...u32(0),
      ...u32(HEADER_LENGTH + body.length),
      ...u32(block.offsets.length),
      ...u32(NULL_INDEX),
      ...u32(NULL_INDEX),
      ...repeat(156),
    ];
    return concat([header, body, idxt]);
  });

  const tagx = align4(
    Uint8Array.from([
      ...ascii('TAGX'),
      ...u32(12 + 4 * (tags.length + 1)),
      ...u32(1),
      ...tags.flatMap((t) => [t.number, t.valuesPerEntry, t.mask, 0]),
      0,
      0,
      0,
      1,
    ]),
  );
  // Each record's last entry name and count, found through the header's own IDXT.
  const geometry: number[] = [];
  const geometryOffsets: number[] = [];
  for (const block of blocks) {
    geometryOffsets.push(HEADER_LENGTH + tagx.length + geometry.length);
    geometry.push(...block.last, ...u16(block.offsets.length));
  }
  const geometryBlock = align4(Uint8Array.from(geometry));
  const idxtOffset = HEADER_LENGTH + tagx.length + geometryBlock.length;
  const header = concat([
    ascii('INDX'),
    u32(HEADER_LENGTH),
    repeat(8),
    u32(2),
    u32(idxtOffset),
    u32(records.length),
    u32(65001),
    u32(NULL_INDEX),
    u32(entries.length),
    u32(0),
    u32(0),
    u32(0),
    u32(strings?.records.length ?? 0),
    repeat(124),
    u32(HEADER_LENGTH),
    repeat(8),
    tagx,
    geometryBlock,
    align4(Uint8Array.from([...ascii('IDXT'), ...geometryOffsets.flatMap(u16)])),
  ]);
  return [header, ...records, ...(strings?.records ?? [])];
}

/** A numbered index entry's name: its number in hexadecimal, padded to `digits`, and to an even length. */
export function hexName(index: number, digits = 2): string {
  const hex = index.toString(16).toUpperCase().padStart(digits, '0');
  return hex.length % 2 ? `0${hex}` : hex;
}
