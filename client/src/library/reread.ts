import type { Item, Library, LibraryBackend, Operation } from '@nexlibris/common';
import { isFormatId, type FormatId, type ParsedItem } from '@nexlibris/tools/formats/formats';
import { parseFile } from '@nexlibris/tools/formats/parseFile';
import { coverColor } from '@nexlibris/tools/coverColor';
import { METADATA_PREFERENCE } from './importFiles';

/**
 * Library cleanup's "Re-read metadata": reads each book's best file again, as import does, and
 * fills in what the item lacks (fields, identifiers, a cover, and creators or tags when it has
 * none), and the cover colour for items with a cover. It never replaces what an item has, which may
 * be the user's edits or Calibre's metadata (whose `metadata.opf` isn't kept). Only the library's
 * own files are read: nothing is fetched from elsewhere.
 */

export interface RereadProgress {
  done: number;
  total: number;
  /** The book being read. */
  current?: string;
}

export interface RereadResult {
  /** Books that gained something. */
  updated: number;
  /** Fields, identifiers, covers and so on filled in. */
  filled: number;
  /** Books whose files aren't stored here (another instance has them), so weren't read. */
  notHere: number;
  failed: { title: string; message: string }[];
  stopped?: boolean;
}

export interface RereadOptions {
  onProgress?(progress: RereadProgress): void;
  signal?: AbortSignal;
  /** For tests: reading files and covers. */
  parse?: (format: FormatId, data: Blob, name: string) => Promise<ParsedItem>;
  color?: (image: Blob) => Promise<string | undefined>;
}

/** Changes are applied this many books at a time, so stopping partway keeps what was done. */
const APPLY_EVERY = 25;

const rank = (format: string) => {
  const index = METADATA_PREFERENCE.indexOf(format as FormatId);
  return index < 0 ? METADATA_PREFERENCE.length : index;
};

/** The operations filling in `item` from what was read out of its file. Exported for tests. */
export function fillIn(item: Item, parsed: ParsedItem | undefined, extra: { cover?: Item['cover']; coverColor?: string }): Operation[] {
  const ops: Operation[] = [];
  const id = item.id;
  if (parsed) {
    for (const [key, value] of Object.entries(parsed.metadata)) {
      if (value !== undefined && item.metadata[key] === undefined) ops.push({ type: 'setMetadata', id, key, value });
    }
    const identifiers = { ...parsed.identifiers, ...item.identifiers };
    const patch: Extract<Operation, { type: 'updateItem' }>['patch'] = {};
    if (Object.keys(identifiers).length > Object.keys(item.identifiers).length) patch.identifiers = identifiers;
    if (!item.creators.length && parsed.creators.length) patch.creators = parsed.creators;
    if (extra.cover) patch.cover = extra.cover;
    if (Object.keys(patch).length) ops.push({ type: 'updateItem', id, patch });
    if (!item.tags.length && parsed.tags.length) ops.push({ type: 'addTags', id, tags: parsed.tags });
  } else if (extra.cover) {
    ops.push({ type: 'updateItem', id, patch: { cover: extra.cover } });
  }
  if (extra.coverColor && !item.metadata.coverColor) ops.push({ type: 'setMetadata', id, key: 'coverColor', value: extra.coverColor });
  return ops;
}

/** How many things an item's fill-in operations fill: each field, identifier, cover, and the creators or tags. */
function countFilled(item: Item, ops: Operation[]): number {
  return ops.reduce((n, op) => {
    if (op.type !== 'updateItem') return n + 1;
    const ids = op.patch.identifiers ? Object.keys(op.patch.identifiers).length - Object.keys(item.identifiers).length : 0;
    return n + ids + (op.patch.creators ? 1 : 0) + (op.patch.cover ? 1 : 0);
  }, 0);
}

/** Re-reads every book's metadata (see the top of this file), applying what it finds with `apply`. */
export async function rereadMetadata(
  backend: LibraryBackend,
  library: Library,
  apply: (ops: Operation[]) => Promise<unknown>,
  options: RereadOptions = {},
): Promise<RereadResult> {
  const parse = options.parse ?? parseFile;
  const color = options.color ?? coverColor;
  const items = Object.values(library.items).filter((item) => item.files.length || (item.cover && !item.metadata.coverColor));
  const result: RereadResult = { updated: 0, filled: 0, notHere: 0, failed: [] };
  let pending: Operation[] = [];
  let pendingBooks = 0;
  const flush = async () => {
    if (pending.length) await apply(pending);
    pending = [];
    pendingBooks = 0;
  };

  for (const [done, item] of items.entries()) {
    if (options.signal?.aborted) {
      result.stopped = true;
      break;
    }
    options.onProgress?.({ done, total: items.length, current: item.title });
    try {
      let parsed: ParsedItem | undefined;
      const files = item.files.filter((f) => isFormatId(f.format)).sort((a, b) => rank(a.format) - rank(b.format));
      let stored = false;
      for (const file of files) {
        if (!(await backend.hasFile(file.hash))) continue;
        stored = true;
        const blob = await backend.getFile(file.hash);
        if (!blob) continue;
        try {
          parsed = await parse(file.format as FormatId, blob, file.name ?? `${item.title}.${file.format}`);
          break;
        } catch {
          // Another format may read where this one doesn't, as at import.
        }
      }
      if (files.length && !stored) result.notHere++;

      let cover: Item['cover'];
      let coverBlob: Blob | undefined;
      if (!item.cover && parsed?.cover) {
        coverBlob = parsed.cover.data;
        cover = { hash: (await backend.putFile(coverBlob)).hash, mediaType: parsed.cover.mediaType };
      } else if (item.cover && !item.metadata.coverColor && (await backend.hasFile(item.cover.hash))) {
        coverBlob = await backend.getFile(item.cover.hash);
      }
      const shade = coverBlob && !item.metadata.coverColor ? await color(coverBlob) : undefined;
      const ops = fillIn(item, parsed, { ...(cover && { cover }), ...(shade && { coverColor: shade }) });
      if (ops.length) {
        result.updated++;
        result.filled += countFilled(item, ops);
        pending.push(...ops);
      }
    } catch (e) {
      result.failed.push({ title: item.title, message: e instanceof Error ? e.message : String(e) });
    }
    if (++pendingBooks >= APPLY_EVERY) await flush();
  }
  await flush();
  options.onProgress?.({ done: items.length, total: items.length });
  return result;
}
