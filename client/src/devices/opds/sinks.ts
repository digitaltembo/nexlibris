import JSZip from 'jszip';
import { saveFile } from '../../library/saveFile';
import { MANIFEST_PATH, type CatalogManifest, type CatalogSink } from './export';

/** A zip of the whole catalog, saved (or offered for download) when it's done. Exports are always complete. */
export function zipSink(name: string, save: (zip: Blob, name: string) => Promise<boolean> = saveFile): CatalogSink & {
  saved?: boolean;
} {
  const zip = new JSZip();
  const sink: CatalogSink & { saved?: boolean } = {
    async write(path, data) {
      // Books and covers are compressed already.
      const compressed = typeof data === 'string';
      zip.file(path, data, { compression: compressed ? 'DEFLATE' : 'STORE', createFolders: false });
    },
    async finish() {
      sink.saved = await save(await zip.generateAsync({ type: 'blob', mimeType: 'application/zip' }), name);
    },
  };
  return sink;
}

declare global {
  interface Window {
    showDirectoryPicker?(options?: { id?: string; mode?: 'read' | 'readwrite' }): Promise<FileSystemDirectoryHandle>;
  }
}

/** Whether this browser can write to a folder the user picks (Chrome and Edge, not Firefox, Safari or the app). */
export const canWriteFolders = () => typeof window !== 'undefined' && typeof window.showDirectoryPicker === 'function';

/**
 * A folder on disk, e.g. one a static host deploys from. It keeps a manifest of what it wrote, so the next
 * export copies only changed books and removes what's no longer in the catalog.
 */
export function directorySink(root: FileSystemDirectoryHandle): CatalogSink {
  const folder = async (path: string[], create: boolean) => {
    let dir = root;
    for (const name of path) dir = await dir.getDirectoryHandle(name, { create });
    return dir;
  };
  const split = (path: string) => {
    const parts = path.split('/');
    return { dirs: parts.slice(0, -1), name: parts.at(-1)! };
  };
  return {
    async readManifest() {
      try {
        const file = await (await root.getFileHandle(MANIFEST_PATH)).getFile();
        const manifest = JSON.parse(await file.text()) as CatalogManifest;
        return manifest.version === 1 ? manifest : undefined;
      } catch {
        return undefined;
      }
    },
    async write(path, data) {
      const { dirs, name } = split(path);
      const handle = await (await folder(dirs, true)).getFileHandle(name, { create: true });
      const writable = await handle.createWritable();
      await writable.write(data);
      await writable.close();
    },
    async remove(path) {
      const { dirs, name } = split(path);
      try {
        await (await folder(dirs, false)).removeEntry(name);
      } catch (e) {
        // Already gone is fine.
        if (!(e instanceof DOMException && e.name === 'NotFoundError')) throw e;
      }
    },
  };
}
