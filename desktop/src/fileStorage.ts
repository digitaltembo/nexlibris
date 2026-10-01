import type { MessageImpl, StorageApi } from '@nexlibris/common';
import { mkdirSync, realpathSync } from 'node:fs';
import { appendFile, mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises';
import { dirname, join, sep } from 'node:path';

/**
 * The library's files on disk: the desktop side of the storage API in
 * `common/src/storageApi.ts`, as `StorageService.kt` is on Android. Paths are
 * slash-separated and relative to `root`. Whole-file writes go to a temporary
 * file that's moved into place, so a reader never sees a partial file.
 */
export function createFileStorage(root: string): MessageImpl<StorageApi>['storage'] {
  mkdirSync(root, { recursive: true });
  const base = realpathSync(root);
  const resolve = (path: string) => resolveLibraryPath(base, path);

  return {
    async readText({ path }) {
      const file = resolve(path);
      return (await isFile(file)) ? readFile(file, 'utf8') : null;
    },
    async writeText({ path, text }) {
      await replace(resolve(path), (temp) => writeSynced(temp, text, 'w'));
      return null;
    },
    async appendText({ path, text }) {
      const file = resolve(path);
      await mkdir(dirname(file), { recursive: true });
      // The change log is appended to; make each append durable before reporting success.
      await writeSynced(file, text, 'a');
      return null;
    },
    async exists({ path }) {
      return isFile(resolve(path));
    },
    async size({ path }) {
      const info = await stat(resolve(path)).catch(() => undefined);
      return info?.isFile() ? info.size : null;
    },
    async readChunk({ path, offset, length }) {
      if (!(offset >= 0 && length >= 0)) throw new Error(`Bad range: ${offset}+${length}`);
      const file = resolve(path);
      if (!(await isFile(file))) throw new Error(`No file: ${path}`);
      const handle = await open(file, 'r');
      try {
        const buffer = Buffer.alloc(length);
        const { bytesRead } = await handle.read(buffer, 0, length, offset);
        return buffer.subarray(0, bytesRead).toString('base64');
      } finally {
        await handle.close();
      }
    },
    async writeChunk({ path, data, first, last }) {
      const file = resolve(path);
      const upload = join(dirname(file), `.${basename(file)}.upload`);
      if (first) {
        await mkdir(dirname(file), { recursive: true });
        await rm(upload, { force: true });
      } else if (!(await isFile(upload))) {
        throw new Error(`No upload in progress: ${path}`);
      }
      await appendFile(upload, Buffer.from(data, 'base64'));
      if (last) await commit(upload, file);
      return null;
    },
  };
}

/** The file for a library path, refusing anything that would leave `root` (which must be a real path). */
export function resolveLibraryPath(root: string, path: string): string {
  const segments = path.split('/');
  if (!path || segments.some((s) => !s || s === '.' || s === '..' || s.includes('\\') || s.includes('\0'))) {
    throw new Error(`Bad path: ${path}`);
  }
  const file = join(root, ...segments);
  // Also catches symlinks pointing outside the library: the deepest part of the path that exists must stay inside.
  let existing = file;
  for (;;) {
    try {
      existing = realpathSync(existing);
      break;
    } catch {
      const parent = dirname(existing);
      if (parent === existing) break;
      existing = parent;
    }
  }
  if (existing !== root && !existing.startsWith(root + sep)) throw new Error(`Bad path: ${path}`);
  return file;
}

const basename = (file: string) => file.slice(file.lastIndexOf(sep) + 1);

async function isFile(file: string) {
  return (await stat(file).catch(() => undefined))?.isFile() ?? false;
}

async function writeSynced(file: string, data: string | Uint8Array, flags: 'w' | 'a') {
  const handle = await open(file, flags);
  try {
    await handle.writeFile(data);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function replace(file: string, write: (temp: string) => Promise<void>) {
  await mkdir(dirname(file), { recursive: true });
  const temp = join(dirname(file), `.${basename(file)}.tmp`);
  await write(temp);
  await rename(temp, file);
}

async function commit(upload: string, file: string) {
  const handle = await open(upload, 'r+');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(upload, file);
}
