import type { MessageImpl, SaveApi } from '@nexlibris/common';
import { mkdirSync, rmSync } from 'node:fs';
import { appendFile, copyFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';

const TOKEN = /^[A-Za-z0-9-]{1,64}$/;

/**
 * Saving files out of the app: the desktop side of `common/src/saveApi.ts`, as
 * `SaveService.kt` is on Android. A file arrives in chunks under a token, into
 * `dir`; `file` then asks the user where it should go and copies it there.
 */
export function createSaveService(
  dir: string,
  /** Asks the user where to save; undefined if they cancel. */
  chooseDestination: (name: string, mimeType: string) => Promise<string | undefined>,
): MessageImpl<SaveApi>['save'] {
  // Anything here is from an earlier run that never finished.
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const upload = (token: string) => {
    if (!TOKEN.test(token)) throw new Error(`Bad token: ${token}`);
    return join(dir, token);
  };
  const isFile = async (file: string) => (await stat(file).catch(() => undefined))?.isFile() ?? false;

  return {
    async chunk({ token, data, first }) {
      const file = upload(token);
      if (first) await rm(file, { force: true });
      else if (!(await isFile(file))) throw new Error(`No upload in progress: ${token}`);
      await appendFile(file, Buffer.from(data, 'base64'));
      return null;
    },
    /** True if saved, false if the user cancelled. The upload is discarded either way. */
    async file({ token, name, mimeType }) {
      const file = upload(token);
      if (!(await isFile(file))) throw new Error(`No upload in progress: ${token}`);
      try {
        const destination = await chooseDestination(name, mimeType);
        if (!destination) return false;
        await copyFile(file, destination);
        return true;
      } finally {
        await rm(file, { force: true });
      }
    },
  };
}
