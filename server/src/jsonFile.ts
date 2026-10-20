import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

/**
 * A JSON file read once and written whole (to a temporary file, then moved into place), with
 * writes one at a time. For the server's small records: accounts, sessions, pairings.
 */
export function jsonFile<T>(file: string, initial: () => T) {
  let value: T | undefined;
  let queue: Promise<unknown> = Promise.resolve();

  async function load(): Promise<T> {
    if (value !== undefined) return value;
    try {
      value = JSON.parse(await readFile(file, 'utf8')) as T;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      value = initial();
    }
    return value;
  }

  return {
    read: load,
    /** Changes the value with `change` and saves it, after any change under way. */
    update<R>(change: (value: T) => R | Promise<R>): Promise<R> {
      const result = queue.then(async () => {
        const current = await load();
        const out = await change(current);
        await mkdir(dirname(file), { recursive: true });
        const temp = `${file}.tmp`;
        await writeFile(temp, JSON.stringify(current, null, 1), { mode: 0o600 });
        await rename(temp, file);
        return out;
      });
      queue = result.catch(() => undefined);
      return result;
    },
  };
}
