/**
 * Zip files written and read a piece at a time, for backups too big to hold in memory.
 *
 * The writer yields headers as bytes and stored data as the caller's own Blobs, untouched, so a
 * multi-GB library's files are never copied into memory: a page can join the parts into one Blob
 * (which keeps referring to the files on disk) or stream them out. Data is stored, or deflated
 * for entries given as text. ZIP64 records are added when sizes or offsets pass 4 GB.
 *
 * The reader slices the zip Blob: it reads the central directory, then each entry only when
 * asked. It reads zips from other tools (JSZip-made backups included), stored or deflated,
 * with or without ZIP64.
 */

export interface ZipEntryInput {
  name: string;
  /** Stored as is; text is deflated. */
  data: Blob | string;
}

/** A piece of a zip being written: header bytes, or an entry's data as given. */
export type ZipPart = Uint8Array | Blob;

const LOCAL = 0x04034b50;
const CENTRAL = 0x02014b50;
const END = 0x06054b50;
const END64 = 0x06064b50;
const END64_LOCATOR = 0x07064b50;
const MAX32 = 0xffffffff;
const MAX16 = 0xffff;
/** Names are UTF-8. */
const UTF8_FLAG = 0x0800;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(bytes: Uint8Array, crc = 0): number {
  let c = ~crc;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8);
  return ~c >>> 0;
}

async function crc32Blob(blob: Blob): Promise<number> {
  let crc = 0;
  const reader = blob.stream().getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return crc;
    crc = crc32(value, crc);
  }
}

async function deflate(text: string): Promise<{ data: Uint8Array; size: number; crc: number }> {
  const bytes = new TextEncoder().encode(text);
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate-raw'));
  const data = new Uint8Array(await new Response(stream).arrayBuffer());
  return { data, size: bytes.length, crc: crc32(bytes) };
}

/** MS-DOS time and date, as zip headers keep them. */
function dosTime(date: Date): { time: number; date: number } {
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    date: (Math.max(0, date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

class Writer {
  private bytes: number[] = [];
  u16(v: number) {
    this.bytes.push(v & 0xff, (v >>> 8) & 0xff);
    return this;
  }
  u32(v: number) {
    this.u16(v & 0xffff).u16(Math.floor(v / 0x10000) & 0xffff);
    return this;
  }
  u64(v: number) {
    this.u32(v % 0x100000000).u32(Math.floor(v / 0x100000000));
    return this;
  }
  raw(data: Uint8Array) {
    for (const b of data) this.bytes.push(b);
    return this;
  }
  done = () => new Uint8Array(this.bytes);
}

interface Written {
  name: Uint8Array;
  method: number;
  crc: number;
  size: number;
  compressedSize: number;
  offset: number;
}

/**
 * A zip of `entries`, as parts in order. `zip64Above` is where ZIP64 starts (only tests lower it).
 */
export async function* zipParts(
  entries: AsyncIterable<ZipEntryInput> | Iterable<ZipEntryInput>,
  { modified = new Date(), zip64Above = MAX32 }: { modified?: Date; zip64Above?: number } = {},
): AsyncGenerator<ZipPart> {
  const { time, date } = dosTime(modified);
  const written: Written[] = [];
  let offset = 0;

  for await (const entry of entries) {
    const name = new TextEncoder().encode(entry.name);
    let data: Blob | Uint8Array;
    let crc: number;
    let size: number;
    let method: number;
    if (typeof entry.data === 'string') {
      const deflated = await deflate(entry.data);
      ({ data, crc, size } = deflated);
      method = 8;
    } else {
      data = entry.data;
      crc = await crc32Blob(entry.data);
      size = entry.data.size;
      method = 0;
    }
    const compressedSize = data instanceof Blob ? data.size : data.length;
    const zip64 = size > zip64Above || compressedSize > zip64Above || offset > zip64Above;

    const header = new Writer()
      .u32(LOCAL)
      .u16(zip64 ? 45 : 20)
      .u16(UTF8_FLAG)
      .u16(method)
      .u16(time)
      .u16(date)
      .u32(crc)
      .u32(zip64 ? MAX32 : compressedSize)
      .u32(zip64 ? MAX32 : size)
      .u16(name.length)
      .u16(zip64 ? 20 : 0)
      .raw(name);
    if (zip64) header.u16(0x0001).u16(16).u64(size).u64(compressedSize);
    const bytes = header.done();
    yield bytes;
    yield data;

    written.push({ name, method, crc, size, compressedSize, offset });
    offset += bytes.length + compressedSize;
  }

  const directoryOffset = offset;
  for (const entry of written) {
    const big = (v: number) => v > zip64Above;
    const extra = new Writer();
    if (big(entry.size)) extra.u64(entry.size);
    if (big(entry.compressedSize)) extra.u64(entry.compressedSize);
    if (big(entry.offset)) extra.u64(entry.offset);
    const extraBytes = extra.done();
    const zip64 = extraBytes.length > 0;
    const header = new Writer()
      .u32(CENTRAL)
      .u16(45)
      .u16(zip64 ? 45 : 20)
      .u16(UTF8_FLAG)
      .u16(entry.method)
      .u16(time)
      .u16(date)
      .u32(entry.crc)
      .u32(big(entry.compressedSize) ? MAX32 : entry.compressedSize)
      .u32(big(entry.size) ? MAX32 : entry.size)
      .u16(entry.name.length)
      .u16(zip64 ? extraBytes.length + 4 : 0)
      .u16(0)
      .u16(0)
      .u16(0)
      .u32(0)
      .u32(big(entry.offset) ? MAX32 : entry.offset)
      .raw(entry.name);
    if (zip64) header.u16(0x0001).u16(extraBytes.length).raw(extraBytes);
    const bytes = header.done();
    yield bytes;
    offset += bytes.length;
  }

  const directorySize = offset - directoryOffset;
  const count = written.length;
  const end = new Writer();
  const zip64End = count >= MAX16 || directoryOffset > zip64Above || directorySize > zip64Above;
  if (zip64End) {
    end
      .u32(END64)
      .u64(44)
      .u16(45)
      .u16(45)
      .u32(0)
      .u32(0)
      .u64(count)
      .u64(count)
      .u64(directorySize)
      .u64(directoryOffset)
      .u32(END64_LOCATOR)
      .u32(0)
      .u64(offset)
      .u32(1);
  }
  end
    .u32(END)
    .u16(0)
    .u16(0)
    .u16(zip64End ? MAX16 : count)
    .u16(zip64End ? MAX16 : count)
    .u32(zip64End ? MAX32 : directorySize)
    .u32(zip64End ? MAX32 : directoryOffset)
    .u16(0);
  yield end.done();
}

/* Reading */

export interface ZipEntry {
  name: string;
  size: number;
  /** The entry's data: a slice of the zip if stored, else inflated. */
  blob(): Promise<Blob>;
  text(): Promise<string>;
}

class Reader {
  private view: DataView;
  constructor(
    bytes: Uint8Array,
    public pos = 0,
  ) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }
  u16() {
    const v = this.view.getUint16(this.pos, true);
    this.pos += 2;
    return v;
  }
  u32() {
    const v = this.view.getUint32(this.pos, true);
    this.pos += 4;
    return v;
  }
  u64() {
    const low = this.u32();
    return low + this.u32() * 0x100000000;
  }
  utf8(length: number) {
    const text = new TextDecoder().decode(new Uint8Array(this.view.buffer, this.view.byteOffset + this.pos, length));
    this.pos += length;
    return text;
  }
}

const bytesOf = async (blob: Blob, start: number, end: number) =>
  new Uint8Array(await blob.slice(start, end).arrayBuffer());

export class NotAZipError extends Error {}

/** The entries of a zip, by name. Throws `NotAZipError` if `zip` isn't one. */
export async function readZip(zip: Blob): Promise<Map<string, ZipEntry>> {
  // The end record is in the last 22 bytes, plus up to 64 KB of comment.
  const tailStart = Math.max(0, zip.size - (22 + MAX16));
  const tail = await bytesOf(zip, tailStart, zip.size);
  let endAt = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tail[i] === 0x50 && tail[i + 1] === 0x4b && tail[i + 2] === 0x05 && tail[i + 3] === 0x06) {
      endAt = i;
      break;
    }
  }
  if (endAt < 0) throw new NotAZipError('Not a zip file.');
  const end = new Reader(tail, endAt + 10);
  let count = end.u16();
  let directorySize = end.u32();
  let directoryOffset = end.u32();

  if (count === MAX16 || directorySize === MAX32 || directoryOffset === MAX32) {
    const locatorAt = tailStart + endAt - 20;
    const locator = new Reader(await bytesOf(zip, locatorAt, locatorAt + 20));
    if (locator.u32() !== END64_LOCATOR) throw new NotAZipError('Damaged zip file (no ZIP64 end record).');
    locator.u32();
    const end64At = locator.u64();
    const end64 = new Reader(await bytesOf(zip, end64At, end64At + 56));
    if (end64.u32() !== END64) throw new NotAZipError('Damaged zip file (bad ZIP64 end record).');
    end64.pos = 32;
    count = end64.u64();
    directorySize = end64.u64();
    directoryOffset = end64.u64();
  }

  const directory = new Reader(await bytesOf(zip, directoryOffset, directoryOffset + directorySize));
  const entries = new Map<string, ZipEntry>();
  for (let i = 0; i < count; i++) {
    if (directory.u32() !== CENTRAL) throw new NotAZipError('Damaged zip file (bad central directory).');
    directory.pos += 6; // versions, flags
    const method = directory.u16();
    directory.pos += 8; // time, date, crc
    let compressedSize = directory.u32();
    let size = directory.u32();
    const nameLength = directory.u16();
    const extraLength = directory.u16();
    const commentLength = directory.u16();
    directory.pos += 8; // disk, attributes
    let offset = directory.u32();
    const name = directory.utf8(nameLength);
    let extra = directory.pos;
    const extraEnd = extra + extraLength;
    while (extra + 4 <= extraEnd) {
      directory.pos = extra;
      const id = directory.u16();
      const length = directory.u16();
      if (id === 0x0001) {
        if (size === MAX32) size = directory.u64();
        if (compressedSize === MAX32) compressedSize = directory.u64();
        if (offset === MAX32) offset = directory.u64();
      }
      extra += 4 + length;
    }
    directory.pos = extraEnd + commentLength;

    const data = async () => {
      const local = new Reader(await bytesOf(zip, offset, offset + 30));
      if (local.u32() !== LOCAL) throw new NotAZipError(`Damaged zip file (bad entry ${name}).`);
      local.pos = 26;
      const start = offset + 30 + local.u16() + local.u16();
      const raw = zip.slice(start, start + compressedSize);
      if (method === 0) return raw;
      if (method !== 8) throw new Error(`Unsupported compression in ${name}.`);
      return new Response(raw.stream().pipeThrough(new DecompressionStream('deflate-raw'))).blob();
    };
    entries.set(name, { name, size, blob: data, text: async () => (await data()).text() });
  }
  return entries;
}
