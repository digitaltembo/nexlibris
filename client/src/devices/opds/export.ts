import { userData, type Device, type FileRef, type Item, type Library, type LibraryBackend, type PlacedFile } from '@nexlibris/common';
import { FORMATS, isFormatId } from '../../formats/formats';
import { filterItems } from '../../library/search';
import { catalogFiles } from '../selection';
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
  books: number;
  written: number;
  unchanged: number;
  /** Feeds, covers and Cloudflare files an earlier export wrote that this one doesn't need. Book files are never removed. */
  removed: number;
  /** Items left out, with no file in a format the connection takes. */
  skipped: string[];
  /** Each book file in the catalog, by path, for recording what the connection holds: those written and those kept from before. */
  placed: Record<string, PlacedFile>;
}

/** Options for hosting on Cloudflare Pages, as calibre3opds offers them (`cloudflare/README.md`). */
export interface CloudflareOptions {
  /** Answers OPDS searches as they're typed (`functions/search/[[searchTerm]].js`, or inside `_worker.js`). */
  searchRouting?: boolean;
  /** HTTP Basic Auth in front of the whole site (`_worker.js`), checked against the `BASIC_USER` and `BASIC_PASS` secrets. */
  basicAuth?: boolean;
}

const WORKER_PATH = '_worker.js';
const SEARCH_FUNCTION_PATH = 'functions/search/[[searchTerm]].js';
/** The switch calibre3opds's exporter turns on in `_worker.js` for search routing. */
const WORKER_SEARCH_OFF = 'const ROUTE_SEARCH = false;';

/** The Cloudflare Pages files for these options, by path (as calibre3opds's `_write_web_files`). */
export async function cloudflareFiles(options: CloudflareOptions): Promise<Record<string, string>> {
  if (!options.basicAuth && !options.searchRouting) return {};
  const [worker, search, ignore, readme] = await Promise.all([
    import('./cloudflare/_worker.js?raw'),
    import('./cloudflare/searchFunction.js?raw'),
    import('./cloudflare/assetsignore.txt?raw'),
    import('./cloudflare/README.md?raw'),
  ]);
  const files: Record<string, string> = { '.assetsignore': ignore.default, 'README.md': readme.default };
  if (options.basicAuth) {
    // Pages ignores functions/ while _worker.js exists, so the worker routes searches too.
    if (!worker.default.includes(WORKER_SEARCH_OFF)) throw new Error('_worker.js has no search routing switch.');
    files[WORKER_PATH] = options.searchRouting ? worker.default.replace(WORKER_SEARCH_OFF, 'const ROUTE_SEARCH = true;') : worker.default;
  } else {
    files[SEARCH_FUNCTION_PATH] = search.default;
  }
  return files;
}

/**
 * Writes an OPDS catalog of a connection's catalog: every file of each book in the formats its
 * type takes (or the files chosen for it), as they're stored, organized as the Library is, with
 * the Cloudflare files `cloudflare` asks for. Book files are only ever added (or replaced, by a
 * book's newer file): ones an earlier export wrote stay, though the feeds no longer list them.
 */
export async function exportCatalog(
  library: Library,
  device: Device,
  type: ConnectionType,
  backend: LibraryBackend,
  sink: CatalogSink,
  onProgress?: (progress: ExportProgress) => void,
  cloudflare: CloudflareOptions = {},
): Promise<ExportResult> {
  const result: ExportResult = { books: 0, written: 0, unchanged: 0, removed: 0, skipped: [], placed: {} };

  // Each item's files: those chosen for it, or those in the connection's formats.
  const chosen = new Map<string, { item: Item; files: FileRef[] }>();
  for (const { item, files } of catalogFiles(library, device, type)) {
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
  const catalog = buildCatalog(books, { title: device.name, categories, searchIndex: !!cloudflare.searchRouting });

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
      key = ref.hash;
      book = { itemId: item.id, hash: ref.hash, size: ref.size };
      read = async () => {
        const stored = await backend.getFile(ref.hash);
        if (!stored) throw new Error(`${item.title}: the file is missing from the library.`);
        return stored;
      };
    }
    manifest.files[file.path] = key;
    onProgress?.({ done: done++, total: copies.length, current: `Writing ${file.path}` });
    if (previous[file.path] === key) {
      result.unchanged++;
      if (book) result.placed[file.path] = book;
      continue;
    }
    const data = await read();
    await sink.write(file.path, data);
    result.written++;
    if (book) result.placed[file.path] = book;
  }
  for (const file of catalog) {
    if (!('text' in file)) continue;
    await sink.write(file.path, file.text);
    manifest.files[file.path] = 'feed';
  }
  const hosting = await cloudflareFiles(cloudflare);
  for (const [path, text] of Object.entries(hosting)) {
    await sink.write(path, text);
    manifest.files[path] = 'hosting';
  }
  // Book files an earlier export wrote stay, recorded as before; feeds, covers and hosting files it doesn't write any more go.
  for (const [path, key] of Object.entries(previous)) {
    if (manifest.files[path] !== undefined) continue;
    if (path.startsWith('books/')) {
      manifest.files[path] = key;
      const placed = device.placed[path];
      if (placed) result.placed[path] = placed;
      continue;
    }
    if (!sink.remove) continue;
    await sink.remove(path);
    result.removed++;
  }
  await sink.write(MANIFEST_PATH, JSON.stringify(manifest));
  await sink.finish?.();
  onProgress?.({ done: copies.length, total: copies.length });
  return result;
}
