import type { Cover, Device, FileHash, Item, Library, LibraryBackend } from '@nexlibris/common';
import type { DeviceTarget, RemoteBook } from '../../devices/types';

/**
 * `.nexlibris-library.json`, at the root of a folder connection: what nexlibris put there, as of
 * its last sync, so another nexlibris (or this one, later) can read the books back with their
 * details. It's written after every sync once the files are in place, so it never lists a file
 * that isn't there yet. Covers are kept beside it, in `.nexlibris-covers/`.
 */
export const MANIFEST_PATH = '/.nexlibris-library.json';
const COVERS = '/.nexlibris-covers';

export interface FolderManifest {
  version: 1;
  /** The library that wrote it last. */
  library: { id: string; name: string };
  updatedAt: string;
  books: ManifestBook[];
}

export interface ManifestBook {
  /** The item as its library had it then; its `files` are the library's, the ones here are `files` below. */
  item: Item;
  files: { path: string; hash: FileHash; size: number; format: string }[];
  /** Where its cover is kept here. */
  cover?: { path: string } & Cover;
}

/** The manifest there, if there's one that can be read. */
export async function readManifest(target: DeviceTarget): Promise<FolderManifest | undefined> {
  try {
    const manifest = JSON.parse(await (await target.download!(MANIFEST_PATH)).text()) as FolderManifest;
    return manifest?.version === 1 && Array.isArray(manifest.books) ? manifest : undefined;
  } catch {
    return undefined;
  }
}

const coverExtension = (mediaType: string) => ({ 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp' })[mediaType] ?? 'jpg';

/**
 * Writes the manifest for what the connection holds now (`device.placed`), with each book's details as
 * the library has them, or as the manifest had them for books the library no longer has. Covers not
 * there yet are copied in.
 */
export async function writeManifest(device: Device, target: DeviceTarget, library: Library, backend: LibraryBackend): Promise<void> {
  const previous = await readManifest(target);
  const byItem = new Map<string, ManifestBook['files']>();
  for (const [path, placed] of Object.entries(device.placed)) {
    const item = library.items[placed.itemId];
    const format = item?.files.find((f) => f.hash === placed.hash)?.format ?? previous?.books.flatMap((b) => b.files).find((f) => f.path === path)?.format;
    if (!format) continue;
    byItem.set(placed.itemId, [...(byItem.get(placed.itemId) ?? []), { path, hash: placed.hash, size: placed.size, format }]);
  }
  const covers = new Set((await target.list(COVERS)).map((f) => f.path));
  const books: ManifestBook[] = [];
  for (const [id, files] of byItem) {
    const item = library.items[id] ?? previous?.books.find((b) => b.item.id === id)?.item;
    if (!item) continue;
    let cover: ManifestBook['cover'];
    if (item.cover) {
      const path = `${COVERS}/${item.cover.hash}.${coverExtension(item.cover.mediaType)}`;
      if (!covers.has(path)) {
        const data = await backend.getFile(item.cover.hash).catch(() => undefined);
        if (data) {
          await target.ensureFolder(COVERS);
          await target.upload(path, data);
          covers.add(path);
        }
      }
      if (covers.has(path)) cover = { path, ...item.cover };
    }
    books.push({ item, files, ...(cover && { cover }) });
  }
  const manifest: FolderManifest = { version: 1, library: { id: library.id, name: library.name }, updatedAt: new Date().toISOString(), books };
  await target.upload(MANIFEST_PATH, new Blob([JSON.stringify(manifest, null, 1)], { type: 'application/json' }));
}

/** A book's file as a listing shows it, with its details from the manifest where it's there. */
export function describe(manifest: FolderManifest | undefined, file: { path: string; size: number }): RemoteBook {
  const book = manifest?.books.find((b) => b.files.some((f) => f.path === file.path));
  if (!book) return file;
  const { item } = book;
  const author = item.creators.find((c) => c.role === 'aut')?.name ?? item.creators[0]?.name;
  const series = typeof item.metadata.series === 'string' ? item.metadata.series : undefined;
  return {
    ...file,
    title: item.title,
    ...(author && { author }),
    ...(series && { series, ...(item.metadata.seriesIndex !== undefined && { seriesIndex: String(item.metadata.seriesIndex) }) }),
    ...(item.tags.length && { tags: item.tags }),
    modified: item.addedAt,
  };
}

/**
 * Brings a book in the folder into the library with its details from the manifest: its file (and
 * cover) stored, and the item added as it was, or the file attached to it if the library has it
 * (another nexlibris of the same library wrote it). Undefined if the manifest doesn't list it.
 */
export async function downloadBook(target: DeviceTarget, path: string, backend: LibraryBackend): Promise<Item | undefined> {
  const manifest = await readManifest(target);
  const book = manifest?.books.find((b) => b.files.some((f) => f.path === path));
  const entry = book?.files.find((f) => f.path === path);
  if (!book || !entry) return undefined;
  const { hash, size } = await backend.putFile(await target.download!(path));
  const library = await backend.getLibrary();
  // As the library that wrote it had it, unless it's been changed there since.
  const known = hash === entry.hash ? book.item.files.find((f) => f.hash === hash) : undefined;
  const ref = { ...(known ?? { format: entry.format }), hash, size };
  const existing = library.items[book.item.id];
  if (existing) {
    if (!existing.files.some((f) => f.hash === hash)) await backend.apply([{ type: 'attachFile', id: existing.id, file: ref }]);
    return (await backend.getLibrary()).items[existing.id];
  }
  let cover: Cover | undefined;
  if (book.cover) {
    const data = await target.download!(book.cover.path).catch(() => undefined);
    if (data) cover = { hash: (await backend.putFile(data)).hash, mediaType: book.cover.mediaType };
  }
  const { cover: _cover, ...rest } = book.item;
  const item: Item = { ...rest, files: [ref], ...(cover && { cover }) };
  await backend.apply([{ type: 'addItem', item }]);
  return item;
}
