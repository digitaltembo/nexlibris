import {
  migrateLibrary,
  type FileHash,
  type Item,
  type Library,
  type LibraryBackend,
  type Operation,
} from '@nexlibris/common';
import { NotAZipError, readZip, zipParts, type ZipEntry, type ZipEntryInput, type ZipPart } from '@nexlibris/tools/zip';

/**
 * A backup is a zip of:
 * - `nexlibris-backup.json`: a {@link BackupManifest}, holding the whole library;
 * - `changes.jsonl`: the change log, for later use by sync (restoring ignores it);
 * - `files/<hash>`: every file and cover the library refers to.
 */
export interface BackupManifest {
  format: typeof BACKUP_FORMAT;
  version: typeof BACKUP_VERSION;
  exportedAt: string;
  library: Library;
}

const BACKUP_FORMAT = 'nexlibris-backup';
const BACKUP_VERSION = 1;
const MANIFEST_PATH = 'nexlibris-backup.json';
const CHANGES_PATH = 'changes.jsonl';
const filePath = (hash: FileHash) => `files/${hash}`;

/** Every file hash an item refers to: its files and its cover. */
const itemHashes = (item: Item): FileHash[] => [
  ...item.files.map((f) => f.hash),
  ...(item.cover ? [item.cover.hash] : []),
];

export interface Backup {
  /** The zip, a piece at a time (see `zipParts`): stored files are passed along as Blobs, not read into memory. */
  parts: AsyncGenerator<ZipPart>;
  /** How many stored files (books, covers) the backup takes in, for progress. */
  fileCount: number;
  /** Files the library refers to but the backend doesn't have, filled in as `parts` is read; the backup is otherwise complete. */
  missing: FileHash[];
}

/**
 * A backup of the library, to be read once (e.g. by `saveParts`). `onFile` is called as each
 * stored file is reached, with how many have been.
 */
export async function exportLibrary(
  backend: LibraryBackend,
  now = new Date(),
  onFile?: (done: number) => void,
): Promise<Backup> {
  const library = await backend.getLibrary();
  const missing: FileHash[] = [];
  const hashes = new Set(Object.values(library.items).flatMap(itemHashes));

  async function* entries(): AsyncGenerator<ZipEntryInput> {
    const manifest: BackupManifest = {
      format: BACKUP_FORMAT,
      version: BACKUP_VERSION,
      exportedAt: now.toISOString(),
      library,
    };
    // Text is deflated; books and images are already compressed, so files are stored as they are.
    yield { name: MANIFEST_PATH, data: JSON.stringify(manifest, null, 1) };
    const changes = await backend.getChanges(0);
    yield { name: CHANGES_PATH, data: changes.map((c) => JSON.stringify(c) + '\n').join('') };
    let done = 0;
    for (const hash of hashes) {
      onFile?.(++done);
      const data = await backend.getFile(hash);
      if (data) yield { name: filePath(hash), data };
      else missing.push(hash);
    }
  }

  return { parts: zipParts(entries(), { modified: now }), fileCount: hashes.size, missing };
}

export const backupFileName = (library: Library, now = new Date()) =>
  `${library.name.replace(/[^\w -]+/g, '').trim() || 'library'} ${now.toISOString().slice(0, 10)}.nexlibris.zip`;

export interface RestoreResult {
  added: Item[];
  /** Items not restored because the library already has them (by id, or by a file they share). */
  skipped: Item[];
  /** Problems that didn't stop an item being restored, e.g. a file missing from the backup. */
  warnings: string[];
}

/**
 * Restores a backup by merging it into the library: items it doesn't already
 * have are added, with their files, ratings, reviews and reading positions. Nothing already in
 * the library is changed or removed.
 */
export async function restoreLibrary(backend: LibraryBackend, backup: Blob): Promise<RestoreResult> {
  const zip = await readZip(backup).catch((e) => {
    throw e instanceof NotAZipError ? new Error('This file is not a nexlibris backup (it is not a zip).') : e;
  });
  const manifest = await readManifest(zip);
  const source = manifest.library;
  const library = await backend.getLibrary();
  const knownHashes = new Set(Object.values(library.items).flatMap((item) => item.files.map((f) => f.hash)));
  const result: RestoreResult = { added: [], skipped: [], warnings: [] };
  const ops: Operation[] = [];

  for (const item of Object.values(source.items)) {
    if (library.items[item.id] || item.files.some((f) => knownHashes.has(f.hash))) {
      result.skipped.push(item);
      continue;
    }
    const stored = new Set<FileHash>();
    for (const hash of itemHashes(item)) {
      const entry = zip.get(filePath(hash));
      if (!entry) continue;
      const put = await backend.putFile(await entry.blob());
      if (put.hash === hash) stored.add(hash);
      else result.warnings.push(`${item.title}: a file in the backup is damaged (${hash.slice(0, 12)}…)`);
    }
    const files = item.files.filter((f) => stored.has(f.hash));
    const lost = item.files.length - files.length;
    if (lost)
      result.warnings.push(`${item.title}: ${lost} file${lost === 1 ? ' is' : 's are'} missing from the backup`);
    const restored: Item = {
      ...item,
      files,
      cover: item.cover && stored.has(item.cover.hash) ? item.cover : undefined,
    };

    ops.push({ type: 'addItem', item: restored });
    for (const [userId, data] of Object.entries(source.userData)) {
      const rating = data.ratings[item.id];
      if (rating !== undefined) ops.push({ type: 'setRating', userId, itemId: item.id, rating });
      const review = data.reviews[item.id];
      if (review) ops.push({ type: 'setReview', userId, itemId: item.id, text: review.text });
      const position = data.positions?.[item.id];
      if (position && stored.has(position.hash)) {
        const { updatedAt: _, ...where } = position;
        ops.push({ type: 'setPosition', userId, itemId: item.id, position: where });
      }
    }
    for (const f of files) knownHashes.add(f.hash);
    result.added.push(restored);
  }

  if (ops.length) await backend.apply(ops);
  return result;
}

async function readManifest(zip: Map<string, ZipEntry>): Promise<BackupManifest> {
  const text = await zip.get(MANIFEST_PATH)?.text();
  if (text === undefined) throw new Error('This file is not a nexlibris backup (it has no manifest).');
  const manifest = JSON.parse(text) as Partial<BackupManifest>;
  if (manifest.format !== BACKUP_FORMAT || !manifest.library) {
    throw new Error('This file is not a nexlibris backup.');
  }
  if (manifest.version !== BACKUP_VERSION) {
    throw new Error('This backup was made by a different version of nexlibris and cannot be restored.');
  }
  // An older library is brought up to date; a newer one is refused (NewerSchemaError says so).
  return { ...manifest, library: migrateLibrary(manifest.library) } as BackupManifest;
}
