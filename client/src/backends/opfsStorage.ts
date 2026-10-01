import type { Storage } from '@nexlibris/common';

/**
 * `Storage` over the Origin Private File System, using the async handle API so
 * it works on the main thread. Moving this into a worker (with sync access
 * handles) is a later optimization.
 */
export class OpfsStorage implements Storage {
  private constructor(private readonly root: FileSystemDirectoryHandle) {}

  static async open(...dirs: string[]): Promise<OpfsStorage> {
    let root = await navigator.storage.getDirectory();
    for (const dir of dirs) root = await root.getDirectoryHandle(dir, { create: true });
    // Ask the browser not to evict the library under storage pressure.
    await navigator.storage.persist?.().catch(() => false);
    return new OpfsStorage(root);
  }

  async readText(path: string) {
    return (await this.readBlob(path))?.text();
  }

  writeText(path: string, text: string) {
    return this.writeBlob(path, new Blob([text]));
  }

  async appendText(path: string, text: string) {
    const handle = await this.fileHandle(path, true);
    const { size } = await handle.getFile();
    const writable = await handle.createWritable({ keepExistingData: true });
    await writable.seek(size);
    await writable.write(text);
    await writable.close();
  }

  async readBlob(path: string) {
    const handle = await this.fileHandle(path, false);
    return handle?.getFile();
  }

  async writeBlob(path: string, blob: Blob) {
    const handle = await this.fileHandle(path, true);
    const writable = await handle.createWritable();
    await writable.write(blob);
    await writable.close();
  }

  async exists(path: string) {
    return (await this.fileHandle(path, false)) !== undefined;
  }

  private fileHandle(path: string, create: true): Promise<FileSystemFileHandle>;
  private fileHandle(path: string, create: false): Promise<FileSystemFileHandle | undefined>;
  private async fileHandle(path: string, create: boolean) {
    const parts = path.split('/');
    const name = parts.pop()!;
    try {
      let dir = this.root;
      for (const part of parts) dir = await dir.getDirectoryHandle(part, { create });
      return await dir.getFileHandle(name, { create });
    } catch (e) {
      if (!create && e instanceof DOMException && e.name === 'NotFoundError') return undefined;
      throw e;
    }
  }
}
