import type { Storage } from '@nexlibris/common';

declare global {
  interface FileSystemFileHandle {
    /** Chrome's, for files in the same file system. */
    move?(destination: FileSystemDirectoryHandle, name: string): Promise<void>;
  }
}

/**
 * `Storage` over the Origin Private File System, using the async handle API so
 * it works on the main thread. Moving this into a worker (with sync access
 * handles) is a later optimization. The same works over a folder of the user's
 * (`OpfsStorage.at`), picked with `showDirectoryPicker`.
 */
export class OpfsStorage implements Storage {
  protected constructor(protected readonly root: FileSystemDirectoryHandle) {}

  static async open(...dirs: string[]): Promise<OpfsStorage> {
    let root = await navigator.storage.getDirectory();
    for (const dir of dirs) root = await root.getDirectoryHandle(dir, { create: true });
    // Ask the browser not to evict the library under storage pressure.
    await navigator.storage.persist?.().catch(() => false);
    return new OpfsStorage(root);
  }

  /** Storage in a folder the user picked. */
  static at(folder: FileSystemDirectoryHandle): OpfsStorage {
    return new OpfsStorage(folder);
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

  async remove(path: string) {
    const parts = path.split('/');
    const name = parts.pop()!;
    try {
      let dir = this.root;
      for (const part of parts) dir = await dir.getDirectoryHandle(part);
      await dir.removeEntry(name);
    } catch (e) {
      if (!(e instanceof DOMException && e.name === 'NotFoundError')) throw e;
    }
  }

  async move(from: string, to: string) {
    const source = await this.fileHandle(from, false);
    if (!source) throw new Error(`No file: ${from}`);
    const parts = to.split('/');
    const name = parts.pop()!;
    let dir = this.root;
    for (const part of parts) dir = await dir.getDirectoryHandle(part, { create: true });
    await this.remove(to);
    try {
      if (source.move) return await source.move(dir, name);
    } catch (e) {
      if (!(e instanceof DOMException && (e.name === 'NotSupportedError' || e.name === 'InvalidModificationError'))) throw e;
    }
    const writable = await (await dir.getFileHandle(name, { create: true })).createWritable();
    await writable.write(await source.getFile());
    await writable.close();
    await this.remove(from);
  }

  async prune(path: string) {
    const parts = path.split('/').slice(0, -1);
    while (parts.length) {
      const name = parts.pop()!;
      try {
        let dir = this.root;
        for (const part of parts) dir = await dir.getDirectoryHandle(part);
        // Without `recursive`, only an empty folder goes.
        await dir.removeEntry(name);
      } catch {
        return;
      }
    }
  }

  /** The paths of the files under `prefix` (a folder, ending in `/`), all the way down. */
  async list(prefix: string): Promise<string[]> {
    const dir = await this.dirHandle(prefix);
    if (!dir) return [];
    const paths: string[] = [];
    const walk = async (handle: FileSystemDirectoryHandle, at: string) => {
      for await (const entry of handle.values()) {
        if (entry.kind === 'file') paths.push(at + entry.name);
        else await walk(entry as FileSystemDirectoryHandle, `${at}${entry.name}/`);
      }
    };
    await walk(dir, prefix);
    return paths;
  }

  /** Deletes the folder `prefix` and everything in it (the whole storage's contents for ``). */
  async removeTree(prefix: string): Promise<void> {
    const parts = prefix.split('/').filter(Boolean);
    const name = parts.pop();
    if (!name) {
      for await (const entry of this.root.values()) await this.root.removeEntry(entry.name, { recursive: true });
      return;
    }
    const parent = await this.dirHandle(parts.length ? `${parts.join('/')}/` : '');
    await parent?.removeEntry(name, { recursive: true }).catch((e: unknown) => {
      if (!(e instanceof DOMException && e.name === 'NotFoundError')) throw e;
    });
  }

  private async dirHandle(prefix: string): Promise<FileSystemDirectoryHandle | undefined> {
    try {
      let dir = this.root;
      for (const part of prefix.split('/').filter(Boolean)) dir = await dir.getDirectoryHandle(part);
      return dir;
    } catch (e) {
      if (e instanceof DOMException && (e.name === 'NotFoundError' || e.name === 'TypeMismatchError')) return undefined;
      throw e;
    }
  }

  protected fileHandle(path: string, create: true): Promise<FileSystemFileHandle>;
  protected fileHandle(path: string, create: false): Promise<FileSystemFileHandle | undefined>;
  protected async fileHandle(path: string, create: boolean) {
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
