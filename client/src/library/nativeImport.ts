import { createMessageClient, importApiMeta, storedFilePath } from '@nexlibris/common';
import { nativeTransport } from '../backends/native';
import { IMPORT_ACCEPT } from '../formats/formats';
import type { ImportSource } from './importFiles';

/** Whether files are picked through the native app (Android, desktop) rather than a file input. */
export const nativeImportAvailable = () => nativeTransport() !== undefined;

/**
 * Has the native app show its file picker and store the chosen files (see `common/src/importApi.ts`);
 * undefined if there's no native app. The files are read from `/library/files/…` as the import
 * reaches them, which the app serves without the bridge.
 */
export async function pickNativeFiles(
  fetchFile: typeof fetch = (input, init) => fetch(input, init),
): Promise<{ files: ImportSource[]; skipped: { name: string; reason: string }[] } | undefined> {
  const transport = nativeTransport();
  if (!transport) return undefined;
  const extensions = IMPORT_ACCEPT.split(',').map((e) => e.replace(/^\./, ''));
  const { files, skipped } = await createMessageClient(importApiMeta, transport).import.pick({ extensions });
  return {
    skipped,
    files: files.map(({ name, hash, size }) => ({
      name,
      stored: { hash, size },
      arrayBuffer: async () => {
        const response = await fetchFile(`/library/${storedFilePath(hash)}`);
        if (!response.ok) throw new Error(`Couldn't read ${name} from the library: ${response.status}`);
        return response.arrayBuffer();
      },
    })),
  };
}
