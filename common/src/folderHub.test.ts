import { describe, expect, it } from 'vitest';
import { StoredLibraryBackend } from './backend';
import { openFolderHub, type FolderStorage, type KeepRule } from './folderHub';
import { createItem, type Operation } from './operations';
import { stateDigest } from './repair';
import { MemoryStorage } from './storage';
import { pairWithHub, previewSync, runSync } from './sync';
import { transferFiles } from './syncFiles';

/** A folder in memory: `MemoryStorage` that can list and remove. */
class MemoryFolder extends MemoryStorage implements FolderStorage {
  private readonly paths = new Set<string>();
  override async writeText(path: string, text: string) {
    this.paths.add(path);
    return super.writeText(path, text);
  }
  override async appendText(path: string, text: string) {
    this.paths.add(path);
    return super.appendText(path, text);
  }
  override async writeBlob(path: string, blob: Blob) {
    this.paths.add(path);
    return super.writeBlob(path, blob);
  }
  override async exists(path: string) {
    return this.paths.has(path);
  }
  override async readBlob(path: string) {
    return this.paths.has(path) ? super.readBlob(path) : undefined;
  }
  override async readText(path: string) {
    return this.paths.has(path) ? super.readText(path) : undefined;
  }
  async list(dir: string) {
    const names = new Set<string>();
    for (const path of this.paths) if (path.startsWith(`${dir}/`)) names.add(path.slice(dir.length + 1).split('/')[0]!);
    return [...names];
  }
  async remove(path: string) {
    this.paths.delete(path);
  }
  /** The book files in it, by contents. */
  async books() {
    const texts: string[] = [];
    for (const path of this.paths) if (path.startsWith('files/')) texts.push(await (await this.readBlob(path))!.text());
    return texts.sort();
  }
}

/** Stands in for the client's search: a `tag:<name>` rule. */
const keepRule: KeepRule = ({ keepFiles }) => {
  const tag = keepFiles?.match(/^tag:(.+)$/)?.[1];
  return tag ? (item) => item.tags.includes(tag) : undefined;
};

async function book(backend: StoredLibraryBackend, title: string, tags: string[] = []) {
  const { hash, size } = await backend.putFile(new Blob([title]));
  const item = createItem({ title, tags, files: [{ hash, size, format: 'epub' }] });
  await backend.apply([{ type: 'addItem', item } satisfies Operation]);
  return hash;
}

/** One device's sync with the folder, as the sync dialog runs it: pair if need be, merge, then files. */
async function syncWithFolder(folder: MemoryFolder, local: StoredLibraryBackend, name: string, keepFiles?: string) {
  const hub = openFolderHub(folder, { name: 'Phone’s folder' });
  const pairing = { ...(await pairWithHub(local, hub.client, 'folder', '', name)), ...(keepFiles && { keepFiles }) };
  await runSync(local, hub.client, pairing, await previewSync(local, hub.client, pairing));
  const library = await local.getLibrary();
  return transferFiles(local, hub.files(local, { origin: library.origin, name, ...(keepFiles && { keepFiles }) }, keepRule), {
    keep: keepRule({ origin: library.origin, ...(keepFiles && { keepFiles }) }, library),
  });
}

describe('folder hub', () => {
  it('syncs two devices through a folder, passing only the files each needs, then clearing them out', async () => {
    const folder = new MemoryFolder();
    const phone = new StoredLibraryBackend(new MemoryStorage(), 'Phone');
    const computer = new StoredLibraryBackend(new MemoryStorage(), 'Computer');
    const fromPhone = await book(phone, 'from the phone');
    const reading = await book(computer, 'reading', ['reading']);
    const shelved = await book(computer, 'shelved');

    // The phone goes first: with no one else there yet, its files stay for whoever comes next.
    expect(await syncWithFolder(folder, phone, 'Phone', 'tag:reading')).toMatchObject({ uploaded: 1, downloaded: 0 });
    expect(await folder.books()).toEqual(['from the phone']);

    // The computer takes the phone's book, and leaves the phone just the one it keeps.
    expect(await syncWithFolder(folder, computer, 'Computer')).toMatchObject({ uploaded: 1, downloaded: 1, unavailable: 0 });
    expect(await computer.hasFile(fromPhone)).toBe(true);
    expect(await folder.books()).toEqual(['reading']);

    // The phone takes it; the folder is left empty of books.
    expect(await syncWithFolder(folder, phone, 'Phone', 'tag:reading')).toMatchObject({ downloaded: 1, notKept: 1 });
    expect(await phone.hasFile(reading)).toBe(true);
    expect(await phone.hasFile(shelved)).toBe(false);
    expect(await folder.books()).toEqual([]);
    expect(stateDigest(await phone.getLibrary()).hash).toBe(stateDigest(await computer.getLibrary()).hash);

    // From then on, a new book on the phone goes straight across.
    const later = await book(phone, 'later');
    expect(await syncWithFolder(folder, phone, 'Phone', 'tag:reading')).toMatchObject({ uploaded: 1 });
    expect(await syncWithFolder(folder, computer, 'Computer')).toMatchObject({ downloaded: 1, uploaded: 0 });
    expect(await computer.hasFile(later)).toBe(true);
    expect(await folder.books()).toEqual([]);
  });

  it('records each device in the folder, and survives a record cut short', async () => {
    const folder = new MemoryFolder();
    const phone = new StoredLibraryBackend(new MemoryStorage());
    await book(phone, 'a');
    await syncWithFolder(folder, phone, 'Phone');
    expect(await folder.list('peers')).toHaveLength(1);
    await folder.writeText('peers/someone.json', '{"origin":');
    const computer = new StoredLibraryBackend(new MemoryStorage());
    await expect(syncWithFolder(folder, computer, 'Computer')).resolves.toMatchObject({ downloaded: 1, failed: [] });
  });
});
