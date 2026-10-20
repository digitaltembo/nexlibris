import { createReadStream } from 'node:fs';
import { copyFile, mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';
import type { Readable } from 'node:stream';

/**
 * Where the server keeps books' files: a folder on its disk, or a bucket (`s3.ts`). Keys are
 * slash-separated, made by the server (`users/<account>/files/<ab>/<hash>`), never by a client.
 * Nothing here is reachable except through the server, which checks who's signed in.
 */
export interface ObjectStore {
  /** Where the files are, in words, for the log. */
  readonly description: string;
  /** The object's size, if there is one. */
  head(key: string): Promise<number | undefined>;
  get(key: string): Promise<{ size: number; body: Readable } | undefined>;
  /**
   * Stores the file at `source` (a temporary file the server wrote) as `key`. It may be moved
   * rather than copied; the caller removes `source` afterwards if it's still there.
   */
  put(key: string, source: string, info: { size: number; sha256: string }): Promise<void>;
  /** Nothing happens if there's no such object. */
  remove(key: string): Promise<void>;
  /** Every key starting with `prefix`. */
  list(prefix: string): Promise<string[]>;
}

/** Refuses keys that could leave the store's folder. */
export function checkKey(key: string): string[] {
  const segments = key.split('/');
  if (!key || segments.some((s) => !s || s === '.' || s === '..' || s.includes('\\') || s.includes('\0'))) {
    throw new Error(`Bad key: ${key}`);
  }
  return segments;
}

/** Objects as files in a folder on the server's disk. */
export function folderStore(root: string): ObjectStore {
  const path = (key: string) => join(root, ...checkKey(key));
  return {
    description: `the folder ${root}`,
    async head(key) {
      const info = await stat(path(key)).catch(() => undefined);
      return info?.isFile() ? info.size : undefined;
    },
    async get(key) {
      const file = path(key);
      const info = await stat(file).catch(() => undefined);
      if (!info?.isFile()) return undefined;
      return { size: info.size, body: createReadStream(file) };
    },
    async put(key, source) {
      const file = path(key);
      await mkdir(dirname(file), { recursive: true });
      try {
        await rename(source, file);
      } catch (e) {
        // On another file system (a mounted volume, say): copy to beside it first, so the object appears whole.
        if ((e as NodeJS.ErrnoException).code !== 'EXDEV') throw e;
        const temp = `${file}.${process.pid}.tmp`;
        await copyFile(source, temp);
        await rename(temp, file);
      }
    },
    async remove(key) {
      await rm(path(key), { force: true });
    },
    async list(prefix) {
      const keys: string[] = [];
      const walk = async (dir: string): Promise<void> => {
        const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
        for (const entry of entries) {
          const full = join(dir, entry.name);
          if (entry.isDirectory()) await walk(full);
          else if (entry.isFile() && !entry.name.endsWith('.tmp')) keys.push(relative(root, full).split(sep).join('/'));
        }
      };
      // Only the folders the prefix could be in.
      const parts = prefix.split('/');
      parts.pop();
      await walk(parts.length ? join(root, ...checkKey(parts.join('/'))) : root);
      return keys.filter((key) => key.startsWith(prefix)).sort();
    },
  };
}
