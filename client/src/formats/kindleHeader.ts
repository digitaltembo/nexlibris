/**
 * A Kindle file's (MOBI, AZW, AZW3) metadata and cover from its headers alone, without
 * decompressing its text: for a dictionary that's hundreds of megabytes, which the full parser
 * holds several times over. The layout: a Palm database header listing records; record 0 holds
 * the PalmDOC header, the MOBI header and the EXTH metadata records; the cover is an image
 * record, counted from the MOBI header's first resource.
 */

export interface KindleHeader {
  title: string;
  authors: string[];
  publisher?: string;
  description?: string;
  subjects: string[];
  published?: string;
  isbn?: string;
  asin?: string;
  language?: string;
  /** The book's text, uncompressed, in bytes: how big it is once read. */
  textLength: number;
  /** DRM: the text can't be read. */
  encrypted: boolean;
  cover?: { data: Uint8Array<ArrayBuffer>; mediaType: string };
}

const NO_INDEX = 0xffffffff;

const IMAGE_TYPES: [number[], string][] = [
  [[0xff, 0xd8, 0xff], 'image/jpeg'],
  [[0x89, 0x50, 0x4e, 0x47], 'image/png'],
  [[0x47, 0x49, 0x46, 0x38], 'image/gif'],
  [[0x42, 0x4d], 'image/bmp'],
];

const ENCODINGS: Record<number, string> = { 1252: 'windows-1252', 65001: 'utf-8' };

/** Reads the headers of a Kindle file; throws if it isn't one. */
export function readKindleHeader(bytes: Uint8Array<ArrayBuffer>): KindleHeader {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const ascii = (at: number, length: number) => String.fromCharCode(...bytes.subarray(at, at + length));
  if (bytes.length < 78) throw new Error('The file is too short to be a Kindle book.');
  const records = view.getUint16(76);
  const recordStart = (index: number) => (index < records ? view.getUint32(78 + index * 8) : bytes.length);
  const record = (index: number) => bytes.subarray(recordStart(index), recordStart(index + 1));

  const first = recordStart(0);
  if (ascii(first + 16, 4) !== 'MOBI') throw new Error('Missing MOBI header');
  const u32 = (at: number) => view.getUint32(first + at);
  const decoder = new TextDecoder(ENCODINGS[u32(28)] ?? 'utf-8');
  const headerLength = u32(20);
  const fullName = decoder.decode(bytes.subarray(first + u32(84), first + u32(84) + u32(88)));
  const firstResource = u32(108);

  const exth: Record<number, Uint8Array[]> = {};
  if (u32(128) & 0x40) {
    let at = first + 16 + headerLength;
    if (ascii(at, 4) === 'EXTH') {
      const count = view.getUint32(at + 8);
      at += 12;
      for (let i = 0; i < count && at + 8 <= bytes.length; i++) {
        const type = view.getUint32(at);
        const length = view.getUint32(at + 4);
        if (length < 8) break;
        (exth[type] ??= []).push(bytes.subarray(at + 8, at + length));
        at += length;
      }
    }
  }
  const strings = (type: number) => (exth[type] ?? []).map((data) => decoder.decode(data).trim()).filter(Boolean);
  const string = (type: number) => strings(type)[0];
  const number = (type: number) => {
    const data = exth[type]?.[0];
    return data && data.length >= 4 ? new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(0) : undefined;
  };

  const header: KindleHeader = {
    title: string(503) ?? fullName.trim(),
    authors: strings(100),
    subjects: strings(105),
    textLength: u32(4),
    encrypted: view.getUint16(first + 12) !== 0,
  };
  const optional = { publisher: string(101), description: string(103), published: string(106), isbn: string(104), asin: string(113), language: string(524) };
  for (const [key, value] of Object.entries(optional)) if (value) header[key as keyof typeof optional] = value;

  // The cover, else the thumbnail: image records counted from the first resource.
  const offset = [number(201), number(202)].find((o) => o !== undefined && o !== NO_INDEX);
  if (offset !== undefined && firstResource !== NO_INDEX && firstResource + offset < records) {
    const data = record(firstResource + offset);
    const mediaType = IMAGE_TYPES.find(([magic]) => magic.every((b, i) => data[i] === b))?.[1];
    if (mediaType) header.cover = { data: data.slice(), mediaType };
  }
  return header;
}
