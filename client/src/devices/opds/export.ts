import { userData, type Device, type FileRef, type Item, type Library, type LibraryBackend, type Operation, type PlacedFile } from '@nexlibris/common';
import { FORMATS, isFormatId } from '../../formats/formats';
import { runConversion } from '../../library/convert';
import { filterItems } from '../../library/search';
import { staleFiles } from '../plan';
import { deviceItems } from '../selection';
import type { ConnectionType } from '../types';
import { buildCatalog, type CatalogBook, type CatalogFile } from './catalog';

/** Where a catalog is written: a zip, a folder on disk, … */
export interface CatalogSink {
  /** What an earlier export wrote here, for destinations that keep files between exports. */
  readManifest?(): Promise<CatalogManifest | undefined>;
  write(path: string, data: Blob | string): Promise<void>;
  remove?(path: string): Promise<void>;
  /** Called once everything is written, e.g. to save the zip. */
  finish?(): Promise<void>;
}

/** Each written path with a key for its content, so unchanged books aren't copied again. */
export interface CatalogManifest {
  version: 1;
  files: Record<string, string>;
}

export const MANIFEST_PATH = 'nexlibris-catalog.json';

export interface ExportProgress {
  done: number;
  total: number;
  current?: string;
}

export interface ExportResult {
  /** Files made for the catalog (e.g. X4 copies), to attach to their items. */
  operations: Operation[];
  books: number;
  written: number;
  unchanged: number;
  removed: number;
  /** Items left out, with no file in a format the device takes. */
  skipped: string[];
  /** Included, but with something to report (e.g. their X4 copy couldn't be made). */
  warnings: { title: string; message: string }[];
  /** Each book file in the catalog, by path, for recording what the connection holds. */
  placed: Record<string, PlacedFile>;
}

/**
 * Writes an OPDS catalog of a connection's items: every format of each item that
 * its type takes (making its preferred one, as a sync does), with the item's
 * current metadata written in.
 */
export async function exportCatalog(
  library: Library,
  device: Device,
  type: ConnectionType,
  backend: LibraryBackend,
  sink: CatalogSink,
  onProgress?: (progress: ExportProgress) => void,
): Promise<ExportResult> {
  const result: ExportResult = {
    operations: [],
    books: 0,
    written: 0,
    unchanged: 0,
    removed: 0,
    skipped: [],
    warnings: [],
    placed: {},
  };
  const items = deviceItems(library, device);

  // Each item's files in the device's formats, making the preferred one where it's missing.
  const chosen = new Map<string, { item: Item; files: FileRef[] }>();
  const makes = type.makes?.(device);
  for (const [n, original] of items.entries()) {
    let item = original;
    const stale = staleFiles(item, makes);
    let files = type.formats.flatMap((format) => item.files.filter((f) => f.format === format && !stale.includes(f)));
    if (makes && !files.some((f) => f.format === makes.to)) {
      const source = makes.from.map((from) => item.files.find((f) => f.format === from)).find((f) => f);
      if (source) {
        onProgress?.({ done: n, total: items.length, current: `Optimizing ${item.title}` });
        try {
          const data = await backend.getFile(source.hash);
          if (!data) throw new Error('The file is missing from the library.');
          const made = await runConversion(backend, item, source, data, makes);
          result.operations.push({ type: 'attachFile', id: item.id, file: made });
          for (const old of stale) result.operations.push({ type: 'detachFile', id: item.id, hash: old.hash });
          item = { ...item, files: [...item.files.filter((f) => !stale.includes(f)), made] };
          files = type.formats.flatMap((format) => item.files.filter((f) => f.format === format));
        } catch (e) {
          result.warnings.push({ title: item.title, message: `couldn’t make ${FORMATS[makes.to].label}: ${errorMessage(e)}` });
        }
      }
    }
    if (files.length) chosen.set(item.id, { item, files });
    else result.skipped.push(item.title);
  }

  const books: CatalogBook[] = [...chosen.values()].map(({ item, files }) => ({
    item,
    formats: files.map((f) => ({ format: f.format, mediaType: isFormatId(f.format) ? FORMATS[f.format].mediaType : 'application/octet-stream' })),
    ...(item.cover && { cover: item.cover }),
  }));
  result.books = books.length;
  // The user's browse categories, as in the app; an entry's search finds its books.
  const { ratings } = userData(library);
  const categories = Object.values(library.categories ?? {}).map((category) => ({
    name: category.name,
    entries: category.entries.map((entry) => ({
      label: entry.label || entry.query,
      itemIds: filterItems(books.map((b) => b.item), entry.query, { ratings }).map((i) => i.id),
    })),
  }));
  const catalog = buildCatalog(books, { title: device.name, categories });

  const previous = (await sink.readManifest?.())?.files ?? {};
  const manifest: CatalogManifest = { version: 1, files: {} };
  const copies = catalog.filter((f): f is Exclude<CatalogFile, { text: string }> => !('text' in f));
  let done = 0;
  for (const file of copies) {
    let key: string;
    let read: () => Promise<Blob>;
    let book: PlacedFile | undefined;
    if ('cover' in file) {
      key = file.cover;
      read = async () => {
        const cover = await backend.getFile(file.cover);
        if (!cover) throw new Error('A cover is missing from the library.');
        return cover;
      };
    } else {
      const { item, files } = chosen.get(file.book.itemId)!;
      const ref = files.find((f) => f.format === file.book.format)!;
      const prepareKey = type.prepare?.key(item, ref);
      key = prepareKey === undefined ? ref.hash : `${ref.hash}:${prepareKey}`;
      book = { itemId: item.id, hash: ref.hash, size: ref.size, ...(prepareKey !== undefined && { key: prepareKey }) };
      read = async () => {
        const stored = await backend.getFile(ref.hash);
        if (!stored) throw new Error(`${item.title}: the file is missing from the library.`);
        return prepareKey !== undefined && type.prepare ? type.prepare.run(item, ref, stored) : stored;
      };
    }
    manifest.files[file.path] = key;
    onProgress?.({ done: done++, total: copies.length, current: `Writing ${file.path}` });
    if (previous[file.path] === key) {
      result.unchanged++;
      if (book) result.placed[file.path] = { ...book, size: device.placed[file.path]?.size ?? book.size };
      continue;
    }
    const data = await read();
    await sink.write(file.path, data);
    result.written++;
    if (book) result.placed[file.path] = { ...book, size: data.size };
  }
  for (const file of catalog) {
    if (!('text' in file)) continue;
    await sink.write(file.path, file.text);
    manifest.files[file.path] = 'feed';
  }
  // Feeds and books an earlier export wrote that this one doesn't, e.g. for a removed tag or book.
  if (sink.remove) {
    for (const path of Object.keys(previous)) {
      if (manifest.files[path] !== undefined) continue;
      await sink.remove(path);
      result.removed++;
    }
  }
  await sink.write(MANIFEST_PATH, JSON.stringify(manifest));
  await sink.finish?.();
  onProgress?.({ done: copies.length, total: copies.length });
  return result;
}

const errorMessage = (e: unknown) => (e instanceof Error ? e.message : String(e));
