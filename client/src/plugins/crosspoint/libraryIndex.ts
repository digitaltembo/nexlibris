/**
 * CrossPoint's library index, `/.crosspoint/library.idx` on the reader's SD card (format CLX1).
 * The reader writes it describing every book on the card, with the metadata it read from each,
 * so one download says what's on the card. A port of the Kaitai Struct definition in
 * `crosspoint-reader/docs/files/library_idx.ksy` (the format is documented in its
 * `docs/file-formats.md`); keep the two in step.
 *
 * Only format version 3 is read: the reader rebuilds an index of any other version when it opens
 * it, so an older one is out of date anyway.
 */

export const LIBRARY_INDEX_PATH = '/.crosspoint/library.idx';

export const LIBRARY_INDEX_VERSION = 3;

export type MetadataStatus = 'not-attempted' | 'extracted' | 'failed';

/** A book on the card, as the index records it. */
export interface IndexedBook {
  /** The file's full path on the card, e.g. `/Books/Dune - Frank Herbert.epub`. */
  path: string;
  folder: string;
  name: string;
  size: number;
  /** The book's own title, or the file name without its extension when it gave none. */
  title: string;
  /** The display author: one spelling for the same person across the library; empty if none. */
  author: string;
  /** The author as this book spells it. */
  sourceAuthor: string;
  /** The primary author's sort form ("Herbert, Frank"), if the book gave one. */
  authorSort: string;
  series: string;
  /** As written in the book, e.g. "3" or "1.5"; empty without a series. */
  seriesIndex: string;
  tags: string[];
  metadata: MetadataStatus;
  /** When the file landed on the card, as an ISO timestamp; undefined if the card didn't say. */
  modified?: string;
  /** The order the reader first saw books in, for those without a time. */
  firstSeen: number;
}

export type ListKind = 'identity' | 'books' | 'groups' | 'mixed';
export type ListRole = 'external' | 'recent' | 'title' | 'author' | 'series' | 'tags' | 'folders' | 'generated' | 'custom';

/**
 * One of the reader's lists (shelves). `books` are indexes into `LibraryIndex.books`; `lists`
 * are indexes into `LibraryIndex.lists` of the lists it contains (for groups and mixed lists).
 */
export interface IndexList {
  kind: ListKind;
  role: ListRole;
  /** Shown as a tab or in the list picker. */
  topLevel: boolean;
  /** Built-in lists (Recent, Title, Author) have none; the reader names them. */
  label?: string;
  icon: number;
  books: number[];
  lists: number[];
}

export interface LibraryIndex {
  /** Whether the reader read each book's metadata, rather than going by file names. */
  metadataEnabled: boolean;
  foldVersion: number;
  books: IndexedBook[];
  lists: IndexList[];
}

const KINDS: ListKind[] = ['identity', 'books', 'groups', 'mixed'];
const ROLES: ListRole[] = ['external', 'recent', 'title', 'author', 'series', 'tags', 'folders', 'generated', 'custom'];
const STATUSES: MetadataStatus[] = ['not-attempted', 'extracted', 'failed'];
const RECORD_SIZE = 128;
const LIST_DESC_SIZE = 16;

export class LibraryIndexError extends Error {}

/** Reads a library index. Throws `LibraryIndexError` for a file that isn't one, or is another version. */
export function parseLibraryIndex(data: ArrayBuffer | Uint8Array): LibraryIndex {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const fail = (message: string): never => {
    throw new LibraryIndexError(`Not a readable library index: ${message}.`);
  };
  if (bytes.length < 64 || text(bytes, 0, 4) !== 'CLX1') fail('it doesn’t start with CLX1');
  const version = bytes[4]!;
  if (version !== LIBRARY_INDEX_VERSION) fail(`it’s version ${version}, not ${LIBRARY_INDEX_VERSION}`);
  const foldVersion = bytes[5]!;
  const u16 = (offset: number) => view.getUint16(offset, true);
  const u32 = (offset: number) => view.getUint32(offset, true);
  const header = {
    bookCount: u16(8),
    folderCount: u16(10),
    folderStart: u32(16),
    recordStart: u32(24),
    listStart: u32(28),
    nameStart: u32(32),
    nameLen: u32(36),
    listLen: u32(44),
    listCount: u16(48),
  };
  const within = (start: number, length: number, what: string) => {
    if (start + length > bytes.length) fail(`${what} runs past the end`);
  };
  within(header.recordStart, header.bookCount * RECORD_SIZE, 'the records');
  within(header.nameStart, header.nameLen, 'the names');
  within(header.listStart, header.listLen, 'the lists');

  const folders: string[] = [];
  let at = header.folderStart;
  for (let i = 0; i < header.folderCount; i++) {
    within(at, 1, 'the folders');
    const length = bytes[at]!;
    within(at + 1, length, 'the folders');
    folders.push(text(bytes, at + 1, length));
    at += 1 + length;
  }

  const books: IndexedBook[] = [];
  for (let i = 0; i < header.bookCount; i++) {
    const record = header.recordStart + i * RECORD_SIZE;
    const nameOffset = u32(record);
    const nameLength = bytes[record + 12]!;
    const folder = folders[u16(record + 10)] ?? fail(`book ${i} is in a folder that isn’t listed`);
    // The name blob: path hash, file name, then length-prefixed fields; later fold versions add more.
    let blob = header.nameStart + nameOffset;
    within(blob, 8 + nameLength, 'a book’s names');
    blob += 8;
    const name = text(bytes, blob, nameLength);
    blob += nameLength;
    const end = header.nameStart + header.nameLen;
    const field = () => {
      if (blob >= end) return '';
      const length = bytes[blob]!;
      within(blob + 1, length, 'a book’s names');
      const value = text(bytes, blob + 1, length);
      blob += 1 + length;
      return value;
    };
    const author = field();
    const title = field();
    const sourceAuthor = field();
    const authorSort = foldVersion >= 5 ? field() : '';
    const [series, seriesIndex, tags] = foldVersion >= 6 ? [field(), field(), field()] : ['', '', ''];
    const modified = fatTime(u32(record + 124));
    books.push({
      path: folder === '/' ? `/${name}` : `${folder}/${name}`,
      folder,
      name,
      size: u32(record + 4),
      title: title || name.replace(/\.[^.]+$/, ''),
      author,
      sourceAuthor,
      authorSort,
      series,
      seriesIndex,
      tags: tags ? tags.split('\n') : [],
      metadata: STATUSES[bytes[record + 15]!] ?? 'not-attempted',
      ...(modified && { modified }),
      firstSeen: u16(record + 8),
    });
  }

  const lists: IndexList[] = [];
  within(header.listStart, header.listCount * LIST_DESC_SIZE, 'the list table');
  for (let i = 0; i < header.listCount; i++) {
    const desc = header.listStart + i * LIST_DESC_SIZE;
    const kind = KINDS[bytes[desc]!] ?? fail(`list ${i} is of an unknown kind`);
    const labelLength = bytes[desc + 3]!;
    const count = u16(desc + 4);
    const entries: number[] = [];
    if (kind !== 'identity') {
      const start = header.listStart + u32(desc + 8);
      within(start, count * 2, `list ${i}`);
      for (let n = 0; n < count; n++) entries.push(u16(start + n * 2));
    }
    const labelStart = header.listStart + u32(desc + 12);
    if (labelLength) within(labelStart, labelLength, `list ${i}’s label`);
    // Groups name later lists; mixed lists flag them with bit 15; anything else is a book.
    const books =
      kind === 'identity' ? [...Array(header.bookCount).keys()] : kind === 'groups' ? [] : entries.filter((e) => !(kind === 'mixed' && e & 0x8000));
    const contained = kind === 'groups' ? entries : kind === 'mixed' ? entries.filter((e) => e & 0x8000).map((e) => e & 0x7fff) : [];
    lists.push({
      kind,
      role: ROLES[bytes[desc + 1]!] ?? 'external',
      topLevel: (bytes[desc + 2]! & 1) === 1,
      ...(labelLength && { label: text(bytes, labelStart, labelLength) }),
      icon: bytes[desc + 6]!,
      books: books.filter((b) => b < header.bookCount),
      lists: contained.filter((l) => l > i && l < header.listCount),
    });
  }

  return { metadataEnabled: (bytes[7]! & 1) === 1, foldVersion, books, lists };
}

/** The books on the reader's Recent list, newest first. */
export function recentBooks(index: LibraryIndex): IndexedBook[] {
  const recent = index.lists.find((list) => list.role === 'recent') ?? index.lists[0];
  return (recent?.books ?? []).map((n) => index.books[n]!).reverse();
}

/** FNV-1a 64 of a path's UTF-8 bytes, as the index keys books (`clixPathHash` in the firmware). */
export function pathHash(path: string): bigint {
  let hash = 14695981039346656037n;
  for (const byte of new TextEncoder().encode(path)) hash = ((hash ^ BigInt(byte)) * 1099511628211n) & 0xffffffffffffffffn;
  return hash;
}

/** A book's stored path hash, for checking a path rebuilt from the index (tests use it). */
export function storedPathHash(data: ArrayBuffer | Uint8Array, book: number): bigint {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const record = view.getUint32(24, true) + book * RECORD_SIZE;
  return view.getBigUint64(view.getUint32(32, true) + view.getUint32(record, true), true);
}

const decoder = new TextDecoder();
const text = (bytes: Uint8Array, start: number, length: number) => decoder.decode(bytes.subarray(start, start + length));

/** A packed FAT date and time (date in the high 16 bits), as local time read as UTC; undefined for zero. */
function fatTime(packed: number): string | undefined {
  if (!packed) return undefined;
  const date = packed >>> 16;
  const time = packed & 0xffff;
  const iso = new Date(
    Date.UTC(1980 + (date >>> 9), ((date >>> 5) & 0xf) - 1, date & 0x1f, time >>> 11, (time >>> 5) & 0x3f, (time & 0x1f) * 2),
  );
  return Number.isNaN(iso.getTime()) ? undefined : iso.toISOString();
}
