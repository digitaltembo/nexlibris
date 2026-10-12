import { DATA_DIR, LAYOUT_PATH, PLACED_PATH, storedFilePath, type FileHash, type FileLayout, type FolderChoice } from '@nexlibris/common';
import { existsSync, realpathSync } from 'node:fs';
import { cp, mkdir, readdir, readFile, rename, rm, rmdir, writeFile } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';
import { resolveLibraryPath } from './fileStorage';

/**
 * Where the library is on disk (see `common/src/libraryFolderApi.ts`): the app's data folder, or
 * a folder of the user's with the books laid out in it (`common/src/placedLibrary.ts`). The choice
 * is kept in the app's settings file; moving the library from one to the other is done here.
 */

export interface Settings {
  /** A folder of the user's; the data folder's `library` if not set. */
  libraryDir?: string;
}

export async function readSettings(file: string): Promise<Settings> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as Settings;
  } catch {
    return {};
  }
}

export async function writeSettings(file: string, settings: Settings): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(`${file}.tmp`, JSON.stringify(settings, null, 2));
  await rename(`${file}.tmp`, file);
}

/** Whether a folder holds a library laid out in it, rather than one kept as the data folder keeps it. */
export const isPlaced = (dir: string) => existsSync(join(dir, ...LAYOUT_PATH.split('/')));

/** Where the library's own files are: `.nexlibris/` in a folder of the user's. */
export const dataDir = (dir: string) => (isPlaced(dir) ? join(dir, DATA_DIR) : dir);

/** What a folder holds already. */
export async function folderHolds(dir: string): Promise<FolderChoice['holds']> {
  if (isPlaced(dir) || existsSync(join(dir, 'library.json'))) return 'library';
  const names = await readdir(dir).catch(() => []);
  return names.some((name) => !IGNORED.has(name)) ? 'files' : 'nothing';
}

/** Files the system leaves in folders, which don't stop one counting as empty. */
const IGNORED = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini']);

/** A placed book file's path, by hash, if the library is laid out in its folder. */
export async function placedFile(root: string, hash: FileHash): Promise<string | undefined> {
  try {
    const placed = JSON.parse(await readFile(join(root, ...PLACED_PATH.split('/')), 'utf8')) as Record<FileHash, string>;
    return placed[hash] ? resolveLibraryPath(root, placed[hash]) : undefined;
  } catch {
    return undefined;
  }
}

/** Moves a file within the library's folder (`Storage.move`), replacing any at `to`. */
export async function moveWithin(root: string, from: string, to: string): Promise<void> {
  const source = resolveLibraryPath(root, from);
  const target = resolveLibraryPath(root, to);
  await mkdir(dirname(target), { recursive: true });
  await rename(source, target);
}

/** Removes the folders `path` is in while they're empty (`Storage.prune`), up to the library's. */
export async function pruneWithin(root: string, path: string): Promise<void> {
  let dir = dirname(resolveLibraryPath(root, path));
  while (dir !== root && dir.startsWith(root + sep)) {
    const names = await readdir(dir).catch(() => undefined);
    if (!names || names.some((name) => !IGNORED.has(name))) return;
    for (const name of names) await rm(join(dir, name), { force: true });
    await rmdir(dir).catch(() => undefined);
    dir = dirname(dir);
  }
}

export interface MoveOptions {
  from: string;
  to: string;
  /** Where books go at `to`; none for a library kept as the data folder keeps it. */
  layout?: FileLayout;
  /** Each book file's path at `to`, by hash. */
  placed?: Record<FileHash, string>;
  onProgress?(done: number, total: number): void;
}

const inside = (dir: string, parent: string) => dir === parent || dir.startsWith(parent + sep);

/**
 * Moves the library from one folder to another: its own files into the new one's data folder, and
 * each stored book file to its place there (or, with no place or something else in the way, into
 * `files/` with the rest). Files are renamed where they can be, copied across disks. If anything
 * fails, what was moved goes back. Once all is moved, what's left of the library at `from` is
 * deleted: the books and `.nexlibris/` from a folder of the user's, leaving whatever else is in it.
 */
export async function moveLibrary({ from: given, to: wanted, layout, placed = {}, onProgress }: MoveOptions): Promise<void> {
  await mkdir(wanted, { recursive: true });
  const from = realpathSync(given);
  const to = realpathSync(wanted);
  if (inside(to, from) || inside(from, to)) throw new Error('The library can’t move into its own folder, or into one its folder is in.');
  const fromPlaced = isPlaced(from);
  const fromData = dataDir(from);
  const toData = layout ? join(to, DATA_DIR) : to;
  if ((await folderHolds(to)) === 'library') throw new Error('That folder has a library already.');

  // Every stored file: placed ones, then those waiting in files/.
  const sources = new Map<FileHash, string>();
  if (fromPlaced) {
    try {
      const index = JSON.parse(await readFile(join(from, ...PLACED_PATH.split('/')), 'utf8')) as Record<FileHash, string>;
      for (const [hash, path] of Object.entries(index)) {
        const file = resolveLibraryPath(from, path);
        if (existsSync(file)) sources.set(hash, file);
      }
    } catch {
      // No books placed yet.
    }
  }
  for (const file of await filesUnder(join(fromData, 'files'))) {
    const hash = file.slice(file.lastIndexOf(sep) + 1);
    if (/^[0-9a-f]{64}$/.test(hash) && !sources.has(hash)) sources.set(hash, file);
  }

  const steps: { from: string; to: string }[] = [];
  const index: Record<FileHash, string> = {};
  const claimed = new Set<string>();
  for (const [hash, source] of sources) {
    const path = layout ? placed[hash] : undefined;
    const target = path ? join(to, ...path.split('/')) : undefined;
    if (path && target && !claimed.has(target.toLowerCase()) && !existsSync(target)) {
      claimed.add(target.toLowerCase());
      index[hash] = path;
      steps.push({ from: source, to: target });
    } else {
      steps.push({ from: source, to: join(toData, ...storedFilePath(hash).split('/')) });
    }
  }
  for (const name of ['library.json', 'changes.jsonl', 'local']) {
    if (existsSync(join(fromData, name))) steps.push({ from: join(fromData, name), to: join(toData, name) });
  }

  const done: { from: string; to: string; copied: boolean }[] = [];
  const written: string[] = [];
  try {
    for (const step of steps) {
      await mkdir(dirname(step.to), { recursive: true });
      let copied = false;
      try {
        await rename(step.from, step.to);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EXDEV') throw e;
        // Another disk: copied, and the original deleted once everything has been.
        await cp(step.from, step.to, { recursive: true, errorOnExist: true, force: false });
        copied = true;
      }
      done.push({ ...step, copied });
      onProgress?.(done.length, steps.length);
    }
    if (layout) {
      for (const [path, value] of [
        [LAYOUT_PATH, layout],
        [PLACED_PATH, index],
      ] as const) {
        const file = join(to, ...path.split('/'));
        await writeFile(file, JSON.stringify(value));
        written.push(file);
      }
    }
  } catch (e) {
    for (const step of done.reverse()) {
      if (step.copied) await rm(step.to, { recursive: true, force: true }).catch(() => undefined);
      else await rename(step.to, step.from).catch(() => undefined);
    }
    for (const file of written) await rm(file, { force: true }).catch(() => undefined);
    throw e;
  }

  // What's left at `from` is the library's, now moved.
  for (const step of done) if (step.copied) await rm(step.from, { recursive: true, force: true });
  if (fromPlaced) {
    await rm(fromData, { recursive: true, force: true });
    for (const step of done) {
      const path = relative(from, step.from);
      if (!path.startsWith('..') && !path.startsWith(DATA_DIR)) await pruneWithin(from, path.split(sep).join('/'));
    }
  } else {
    // The data folder held only the library; what's left is emptied folders in files/ (and the folder itself).
    await rm(join(from, 'files'), { recursive: true, force: true });
    await rmdir(from).catch(() => undefined);
  }
}

async function filesUnder(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await filesUnder(path)));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}
