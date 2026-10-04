import {
  STORE_BATCH_BYTES,
  STORE_BATCH_FILES,
  storedFilePath,
  type ChosenFile,
  type ImportApi,
  type MessageImpl,
  type PickedFile,
  type Skipped,
} from '@nexlibris/common';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, mkdirSync, realpathSync } from 'node:fs';
import { mkdir, open, readdir, rename, rm, stat } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { resolveLibraryPath } from './fileStorage';

/**
 * Importing files: the desktop side of `common/src/importApi.ts`, as `ImportService.kt` is on
 * Android. Picked files are copied straight into the library's stored files, hashed as they're
 * copied, rather than read by the page and sent back over IPC.
 */
export function createImportService(
  root: string,
  /**
   * Asks the user for files to import, offering these extensions, or for a folder; the chosen
   * paths, empty if they cancel.
   */
  choose: (options: { extensions: string[]; folder: boolean }) => Promise<string[]>,
): MessageImpl<ImportApi>['import'] {
  mkdirSync(root, { recursive: true });
  const base = realpathSync(root);
  /** The latest pick, for `store`: each chosen file with where it is on disk. */
  let latest: { token: string; files: (ChosenFile & { source: string })[] } | undefined;

  return {
    async pick({ extensions, folder = false, names = [] }) {
      const suffixes = extensions.map((e) => `.${e.toLowerCase()}`);
      const wanted = new Set(names.map((n) => n.toLowerCase()));
      const files: (ChosenFile & { source: string })[] = [];
      const skipped: Skipped[] = [];
      const picked: { source: string; path?: string }[] = [];
      for (const chosen of await choose({ extensions, folder })) {
        if (!folder) picked.push({ source: chosen });
        else for await (const path of walk(chosen, basename(chosen))) picked.push({ source: join(dirname(chosen), path), path });
      }
      for (const { source, path } of picked) {
        const name = basename(source);
        const lower = name.toLowerCase();
        if (!suffixes.some((s) => lower.endsWith(s)) && !(folder && wanted.has(lower))) {
          skipped.push({ name: path ?? name, reason: 'unsupported file type' });
          continue;
        }
        const size = (await stat(source).catch(() => undefined))?.size ?? 0;
        files.push({ name, ...(path !== undefined && { path }), size, source });
      }
      latest = { token: randomUUID(), files };
      return { token: latest.token, files: files.map(({ source: _source, ...file }) => file), skipped };
    },

    async store({ token, start }) {
      if (!latest || latest.token !== token) throw new Error('This import was replaced by another; pick the files again.');
      const files: PickedFile[] = [];
      const skipped: Skipped[] = [];
      let next = start;
      let bytes = 0;
      while (next < latest.files.length && next - start < STORE_BATCH_FILES && bytes < STORE_BATCH_BYTES) {
        const { source, ...chosen } = latest.files[next++]!;
        try {
          const stored = await storeFile(base, source);
          files.push({ ...chosen, ...stored });
          bytes += stored.size;
        } catch (e) {
          skipped.push({ name: chosen.path ?? chosen.name, reason: e instanceof Error ? e.message : String(e) });
        }
      }
      if (next >= latest.files.length) latest = undefined;
      return { files, skipped, next };
    },
  };
}

/** The files in a folder and its subfolders, as paths from `prefix`, in name order; hidden ones and symlinks are left out. */
async function* walk(dir: string, prefix: string): AsyncGenerator<string> {
  const entries = (await readdir(dir, { withFileTypes: true })).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    if (entry.isDirectory()) yield* walk(join(dir, entry.name), `${prefix}/${entry.name}`);
    else if (entry.isFile()) yield `${prefix}/${entry.name}`;
  }
}

/** Copies a file into the library's content-addressed files; storing contents already there is a no-op. */
export function storeFile(root: string, source: string): Promise<{ hash: string; size: number }> {
  // Opened as it's read, so an error opening it (no such file) surfaces where the copy is awaited.
  return storeStream(
    root,
    (async function* () {
      yield* createReadStream(source) as AsyncIterable<Buffer>;
    })(),
  );
}

/**
 * Stores a stream of bytes as a content-addressed file, hashing it as it's written. With `expected`,
 * contents with any other hash are discarded and it throws: nothing is stored under the wrong name.
 */
export async function storeStream(
  root: string,
  chunks: AsyncIterable<Buffer | Uint8Array> | Iterable<Buffer | Uint8Array>,
  expected?: string,
): Promise<{ hash: string; size: number }> {
  const filesDir = resolveLibraryPath(root, 'files');
  await mkdir(filesDir, { recursive: true });
  const temp = join(filesDir, `.import-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`);
  const hash = createHash('sha256');
  let size = 0;
  const out = await open(temp, 'w');
  try {
    for await (const chunk of chunks) {
      hash.update(chunk);
      size += chunk.length;
      await out.write(chunk);
    }
    await out.sync();
  } catch (e) {
    await out.close();
    await rm(temp, { force: true });
    throw e;
  }
  await out.close();
  const digest = hash.digest('hex');
  if (expected !== undefined && digest !== expected) {
    await rm(temp, { force: true });
    throw new Error(`The file's contents don't match its hash (expected ${expected.slice(0, 12)}…, got ${digest.slice(0, 12)}…).`);
  }
  const file = resolveLibraryPath(root, storedFilePath(digest));
  if ((await stat(file).catch(() => undefined))?.isFile()) {
    await rm(temp, { force: true });
  } else {
    await mkdir(dirname(file), { recursive: true });
    await rename(temp, file);
  }
  return { hash: digest, size };
}
