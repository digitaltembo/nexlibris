import type { DeviceTarget, RemoteFile } from '../../devices/types';
import { t } from '../../i18n';

/**
 * A folder the user picked, as a device: paths are absolute from its root (`/Frank Herbert/Dune.epub`).
 * Moving copies then deletes, as folder handles can't rename everywhere. Folders are only ever removed
 * when empty.
 */
export class FolderTarget implements DeviceTarget {
  constructor(private readonly root: () => Promise<FileSystemDirectoryHandle>) {}

  async connect() {
    return { description: `the folder “${(await this.root()).name}”` };
  }

  async list(folder: string): Promise<RemoteFile[]> {
    const dir = await this.folder(folder, false);
    if (!dir) return [];
    const files: RemoteFile[] = [];
    for await (const [name, handle] of entries(dir)) {
      if (handle.kind !== 'file' || name.startsWith('.')) continue;
      files.push({ path: join(folder, name), size: (await (handle as FileSystemFileHandle).getFile()).size });
    }
    return files;
  }

  /** Every file below a folder, for listing what's there; hidden ones (`.nexlibris-library.json`, say) left out. */
  async walk(folder = '/'): Promise<RemoteFile[]> {
    const dir = await this.folder(folder, false);
    if (!dir) return [];
    const files: RemoteFile[] = [];
    for await (const [name, handle] of entries(dir)) {
      if (name.startsWith('.')) continue;
      if (handle.kind === 'directory') files.push(...(await this.walk(join(folder, name))));
      else files.push({ path: join(folder, name), size: (await (handle as FileSystemFileHandle).getFile()).size });
    }
    return files;
  }

  async ensureFolder(folder: string) {
    await this.folder(folder, true);
  }

  async upload(path: string, data: Blob) {
    const { dir, name } = split(path);
    const handle = await (await this.folder(dir, true))!.getFileHandle(name, { create: true });
    const writable = await handle.createWritable();
    await writable.write(data);
    await writable.close();
  }

  async remove(path: string) {
    const { dir, name } = split(path);
    try {
      await (await this.folder(dir, false))?.removeEntry(name);
    } catch (e) {
      if (!(e instanceof DOMException && e.name === 'NotFoundError')) throw e;
    }
  }

  async download(path: string): Promise<Blob> {
    const { dir, name } = split(path);
    const folder = await this.folder(dir, false);
    if (!folder) throw new Error(t('errors.notThere', { path }));
    return (await folder.getFileHandle(name)).getFile();
  }

  async move(from: string, to: string) {
    await this.upload(to, await this.download(from));
    await this.remove(from);
  }

  /** A folder by its path, made if `create`; undefined if it isn't there. */
  private async folder(path: string, create: boolean): Promise<FileSystemDirectoryHandle | undefined> {
    let dir = await this.root();
    for (const part of path.split('/').filter(Boolean)) {
      try {
        dir = await dir.getDirectoryHandle(part, { create });
      } catch (e) {
        if (!create && e instanceof DOMException && (e.name === 'NotFoundError' || e.name === 'TypeMismatchError')) return undefined;
        throw e;
      }
    }
    return dir;
  }
}

const join = (folder: string, name: string) => `${folder.replace(/\/+$/, '')}/${name}`;

function split(path: string) {
  const at = path.lastIndexOf('/');
  return { dir: path.slice(0, at) || '/', name: path.slice(at + 1) };
}

function entries(dir: FileSystemDirectoryHandle): AsyncIterable<[string, FileSystemHandle]> {
  return (dir as unknown as { entries(): AsyncIterable<[string, FileSystemHandle]> }).entries();
}
