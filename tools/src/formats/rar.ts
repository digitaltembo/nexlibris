import { crc32 } from '../zip';

/**
 * RAR archives written with their files stored, not compressed: RAR's compression is proprietary,
 * but its archive format is published (RARLAB's "RAR 5.0 archive format"). Enough for a CBR, whose
 * pages are already compressed images. unrar, libarchive and so most comic readers read RAR 5.
 */

export interface RarEntry {
  /** A path within the archive, `/` between folders. */
  name: string;
  data: Uint8Array;
}

const SIGNATURE = [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x01, 0x00];
const MAIN = 1;
const FILE = 2;
const END = 5;
/** Header flag: a data area follows the header. */
const HAS_DATA = 0x0002;
/** File flags: the modification time and the data's CRC32 are given. */
const HAS_MTIME = 0x0002;
const HAS_CRC = 0x0004;
const UNIX = 1;
/** A regular file, readable by all and writable by its owner (`0o100644`). */
const FILE_MODE = 0o100644;

/** A variable-length integer: 7 bits a byte, least significant first, the high bit on all but the last. */
function vint(value: number): number[] {
  const bytes: number[] = [];
  do {
    const low = value % 128;
    value = Math.floor(value / 128);
    bytes.push(value ? low | 0x80 : low);
  } while (value);
  return bytes;
}

const uint32 = (value: number) => [value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff];

/** A block: its CRC32 and size, then `fields` (its type onwards). The CRC covers the size and fields. */
function block(fields: number[]): Uint8Array<ArrayBuffer> {
  const sized = new Uint8Array([...vint(fields.length), ...fields]);
  return new Uint8Array([...uint32(crc32(sized)), ...sized]);
}

/** A RAR 5 archive of `entries`, stored, each dated `modified`. */
export function writeRar(entries: RarEntry[], modified = new Date()): Blob {
  const mtime = Math.floor(modified.getTime() / 1000);
  const parts: Uint8Array<ArrayBuffer>[] = [new Uint8Array(SIGNATURE), block([...vint(MAIN), 0, 0])];
  for (const entry of entries) {
    const name = new TextEncoder().encode(entry.name.replace(/\\/g, '/'));
    const size = entry.data.length;
    parts.push(
      block([
        ...vint(FILE),
        ...vint(HAS_DATA),
        ...vint(size),
        ...vint(HAS_MTIME | HAS_CRC),
        ...vint(size),
        ...vint(FILE_MODE),
        ...uint32(mtime),
        ...uint32(crc32(entry.data)),
        // Compression: version 0, not solid, method 0 (stored), no dictionary.
        0,
        ...vint(UNIX),
        ...vint(name.length),
        ...name,
      ]),
      new Uint8Array(entry.data),
    );
  }
  parts.push(block([...vint(END), 0, 0]));
  return new Blob(parts, { type: 'application/vnd.comicbook-rar' });
}
