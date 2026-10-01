import { storedFilePath, type ImportApi, type MessageImpl } from '@nexlibris/common';
import { createHash } from 'node:crypto';
import { createReadStream, mkdirSync, realpathSync } from 'node:fs';
import { mkdir, open, rename, rm, stat } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { resolveLibraryPath } from './fileStorage';

/**
 * Importing files: the desktop side of `common/src/importApi.ts`, as `ImportService.kt` is on
 * Android. Picked files are copied straight into the library's stored files, hashed as they're
 * copied, rather than read by the page and sent back over IPC.
 */
export function createImportService(
  root: string,
  /** Asks the user for files to import, offering these extensions; their paths, empty if they cancel. */
  choose: (extensions: string[]) => Promise<string[]>,
): MessageImpl<ImportApi>['import'] {
  mkdirSync(root, { recursive: true });
  const base = realpathSync(root);

  return {
    async pick({ extensions }) {
      const suffixes = extensions.map((e) => `.${e.toLowerCase()}`);
      const files: { name: string; hash: string; size: number }[] = [];
      const skipped: { name: string; reason: string }[] = [];
      for (const path of await choose(extensions)) {
        const name = basename(path);
        if (!suffixes.some((s) => name.toLowerCase().endsWith(s))) {
          skipped.push({ name, reason: 'unsupported file type' });
          continue;
        }
        try {
          files.push({ name, ...(await storeFile(base, path)) });
        } catch (e) {
          skipped.push({ name, reason: e instanceof Error ? e.message : String(e) });
        }
      }
      return { files, skipped };
    },
  };
}

/** Copies a file into the library's content-addressed files; storing contents already there is a no-op. */
export async function storeFile(root: string, source: string): Promise<{ hash: string; size: number }> {
  const filesDir = resolveLibraryPath(root, 'files');
  await mkdir(filesDir, { recursive: true });
  const temp = join(filesDir, `.import-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`);
  const hash = createHash('sha256');
  let size = 0;
  const out = await open(temp, 'w');
  try {
    for await (const chunk of createReadStream(source)) {
      hash.update(chunk as Buffer);
      size += (chunk as Buffer).length;
      await out.write(chunk as Buffer);
    }
    await out.sync();
  } catch (e) {
    await out.close();
    await rm(temp, { force: true });
    throw e;
  }
  await out.close();
  const digest = hash.digest('hex');
  const file = resolveLibraryPath(root, storedFilePath(digest));
  if ((await stat(file).catch(() => undefined))?.isFile()) {
    await rm(temp, { force: true });
  } else {
    await mkdir(dirname(file), { recursive: true });
    await rename(temp, file);
  }
  return { hash: digest, size };
}
