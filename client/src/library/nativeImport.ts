import { createMessageClient, DATA_DIR, importApiMeta, storedFilePath, type RpcSend, type Skipped } from '@nexlibris/common';
import { libraryPlace } from './libraryFolder';
import { nativeTransport } from '../backends/native';
import { IMPORT_ACCEPT } from '@nexlibris/tools/formats/formats';
import { quietlySkipped, SIDECAR_NAMES, type ImportSource } from './importFiles';

/** Whether files are picked through the native app (Android, desktop) rather than a file input. */
export const nativeImportAvailable = () => nativeTransport() !== undefined;

/** How far the native app has got copying picked files into the library. */
export interface CopyProgress {
  files: number;
  totalFiles: number;
  /** Bytes, as the system reported the files' sizes (0 for any it didn't). */
  bytes: number;
  totalBytes: number;
  /** The file being copied. */
  current?: string;
}

export interface NativePickOptions {
  /** Pick a folder, keeping its files' paths so books group as they do from a browser's folder input. */
  folder?: boolean;
  /** Called once the files are chosen, and as they're copied. */
  onCopy?(progress: CopyProgress): void;
  /** Stops copying between batches; what was copied stays stored, and nothing is returned to import. */
  signal?: AbortSignal;
}

/**
 * Has the native app show its file (or folder) picker and store the chosen files a batch at a
 * time (see `common/src/importApi.ts`); undefined if there's no native app or the copying was
 * stopped. The files are read from `/library/files/…` (or `/library/.nexlibris/files/…`) as the import reaches them, which the app
 * serves without the bridge.
 */
export async function pickNativeFiles(
  { folder = false, onCopy, signal }: NativePickOptions = {},
  transport: RpcSend | undefined = nativeTransport(),
  fetchFile: typeof fetch = (input, init) => fetch(input, init),
): Promise<{ files: ImportSource[]; skipped: Skipped[] } | undefined> {
  if (!transport) return undefined;
  const api = createMessageClient(importApiMeta, transport).import;
  const extensions = IMPORT_ACCEPT.split(',').map((e) => e.replace(/^\./, ''));
  const chosen = await api.pick(folder ? { extensions, folder, names: SIDECAR_NAMES } : { extensions });
  const skipped = folder ? chosen.skipped.filter((s) => !quietlySkipped(s.name)) : [...chosen.skipped];
  const files: ImportSource[] = [];
  const totalBytes = chosen.files.reduce((sum, f) => sum + f.size, 0);
  let bytes = 0;
  let next = 0;
  while (next < chosen.files.length) {
    const current = chosen.files[next]!;
    onCopy?.({ files: next, totalFiles: chosen.files.length, bytes, totalBytes, current: current.path ?? current.name });
    if (signal?.aborted) return undefined;
    const batch = await api.store({ token: chosen.token, start: next });
    for (const file of chosen.files.slice(next, batch.next)) bytes += file.size;
    next = batch.next;
    skipped.push(...batch.skipped);
    for (const { name, path, hash, size } of batch.files) {
      files.push(storedSource({ name, hash, size, ...(path && { path }) }, fetchFile));
    }
  }
  onCopy?.({ files: next, totalFiles: chosen.files.length, bytes, totalBytes });
  return { files, skipped };
}

/**
 * A file the app has stored in the library already (picked to import, or downloaded), as an import
 * reads it: from `/library/files/…`, which the app serves without the bridge.
 */
export function storedSource(
  { name, hash, size, path }: { name: string; hash: string; size: number; path?: string },
  fetchFile: typeof fetch = (input, init) => fetch(input, init),
): ImportSource {
  return {
    name,
    ...(path && { webkitRelativePath: path }),
    stored: { hash, size },
    arrayBuffer: async () => {
      // In a folder of the user's, the app stores imports in its .nexlibris folder.
      const dir = libraryPlace().kind === 'folder' ? `${DATA_DIR}/` : '';
      const response = await fetchFile(`/library/${dir}${storedFilePath(hash)}`);
      if (!response.ok) throw new Error(`Couldn't read ${name} from the library: ${response.status}`);
      return response.arrayBuffer();
    },
  };
}
