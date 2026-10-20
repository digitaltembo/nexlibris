import { MemoryStorage, StoredLibraryBackend, type Item, type RpcRequest } from '@nexlibris/common';
import { describe, expect, it } from 'vitest';
import {
  canShowFiles,
  copyFromCloud,
  copyToCloud,
  libraryPlace,
  openNativeLibrary,
  relocate,
  showFileInFolder,
  type CloudAccount,
  type Tree,
} from './libraryFolder';

class MemoryTree extends MemoryStorage implements Tree {
  async list(prefix: string) {
    return this.allPaths().filter((path) => path.startsWith(prefix));
  }
  async removeTree(prefix: string) {
    for (const path of await this.list(prefix)) await this.remove(path);
  }
}

const hashA = 'a'.repeat(64);
const hashB = 'b'.repeat(64);

/** A library as the browser's storage keeps it. */
async function browserLibrary() {
  const tree = new MemoryTree();
  await tree.writeText('library.json', '{}');
  await tree.writeText('changes.jsonl', '');
  await tree.writeText('local/pairings.json', '[]');
  await tree.writeText(`files/aa/${hashA}`, 'dune');
  await tree.writeText(`files/bb/${hashB}`, 'cover');
  return tree;
}

const layout = { folder: '<author>/<title>', fileName: '<title>' };

describe('moving the browser’s library', () => {
  it('into a folder, laid out, leaving what else is there; then back', async () => {
    const browser = await browserLibrary();
    const folder = new MemoryTree();
    await folder.writeText('notes.txt', 'mine');
    const progress: number[] = [];
    await relocate({ tree: browser, placed: false }, { tree: folder, layout }, new Map([[hashA, 'Frank Herbert/Dune/Dune.epub']]), (p) =>
      progress.push(p.done),
    );
    expect(folder.allPaths()).toEqual([
      '.nexlibris/changes.jsonl',
      `.nexlibris/files/bb/${hashB}`,
      '.nexlibris/layout.json',
      '.nexlibris/library.json',
      '.nexlibris/local/pairings.json',
      '.nexlibris/placed.json',
      'Frank Herbert/Dune/Dune.epub',
      'notes.txt',
    ]);
    expect(browser.allPaths()).toEqual([]);
    expect(progress).toEqual([1, 2, 3, 4, 5]);

    await relocate({ tree: folder, placed: true }, { tree: browser }, new Map());
    expect(browser.allPaths()).toEqual(['changes.jsonl', `files/aa/${hashA}`, `files/bb/${hashB}`, 'library.json', 'local/pairings.json']);
    expect(folder.allPaths()).toEqual(['notes.txt']);
  });

  it('leaves the library where it was if a copy fails, and refuses a folder with a library', async () => {
    const browser = await browserLibrary();
    const folder = new MemoryTree();
    const failing = Object.assign(folder, {
      writeBlob: async (path: string, blob: Blob) => {
        if (path.endsWith('library.json')) throw new Error('Disk full');
        await MemoryStorage.prototype.writeBlob.call(folder, path, blob);
      },
    });
    await expect(relocate({ tree: browser, placed: false }, { tree: failing, layout }, new Map([[hashA, 'Dune.epub']]))).rejects.toThrow('Disk full');
    expect(folder.allPaths()).toEqual([]);
    expect(browser.allPaths()).toHaveLength(5);

    const other = await browserLibrary();
    await expect(relocate({ tree: browser, placed: false }, { tree: other }, new Map())).rejects.toThrow(/has a library/);
  });
});

describe('showing a book’s file', () => {
  it('asks the desktop app to show where it’s stored', async () => {
    const calls: RpcRequest[] = [];
    await openNativeLibrary(async (request) => {
      calls.push(request);
      if (request.url === 'api/libraryFolder/location') {
        return { path: '/library', isDefault: true, placed: false, defaultHasLibrary: false };
      }
      return null;
    }, 'desktop');
    expect(libraryPlace().kind).toBe('app');
    expect(canShowFiles()).toBe(true);
    await showFileInFolder(hashA);
    expect(calls.at(-1)).toMatchObject({ url: 'api/libraryFolder/showFile', body: { path: `files/aa/${hashA}` } });
  });

  it('on Android, opens a library in a folder laid out, and can’t show files', async () => {
    const files = new MemoryStorage();
    await files.writeText('.nexlibris/layout.json', JSON.stringify(layout));
    await openNativeLibrary(async ({ url, body }) => {
      if (url === 'api/libraryFolder/location') {
        return { path: 'Documents/Books', isDefault: false, placed: true, defaultHasLibrary: true };
      }
      if (url === 'api/storage/readText') return files.readText((body as { path: string }).path);
      if (url === 'api/storage/exists') return files.exists((body as { path: string }).path);
      return null;
    }, 'android');
    expect(libraryPlace()).toMatchObject({ kind: 'folder', app: 'android', name: 'Documents/Books' });
    expect(canShowFiles()).toBe(false);
    await expect(showFileInFolder(hashA)).rejects.toThrow();
  });
});

/** An account's library as the server keeps it, without the server. */
function fakeAccount(): CloudAccount & { storage: MemoryTree } {
  const storage = new MemoryTree();
  const account = {
    storage,
    backend: new StoredLibraryBackend(storage),
    api: {
      async status() {
        const library = await account.backend.getLibrary();
        return { exists: library.revision > 0, items: Object.keys(library.items).length, files: 0, bytes: 0 };
      },
      async missing({ hashes }: { hashes: string[] }) {
        const lacking: string[] = [];
        for (const hash of hashes) if (!(await account.backend.hasFile(hash))) lacking.push(hash);
        return lacking;
      },
      async import({ library, changes }: { library: unknown; changes: unknown[] }) {
        await storage.writeText('changes.jsonl', changes.map((c) => JSON.stringify(c) + '\n').join(''));
        await storage.writeText('library.json', JSON.stringify(library));
        account.backend = new StoredLibraryBackend(storage);
        return null;
      },
      async remove() {
        await storage.removeTree('');
        return null;
      },
    },
  };
  return account;
}

const book = (id: string, files: Item['files']): Item => ({
  id,
  kind: 'book',
  title: id,
  creators: [],
  identifiers: {},
  tags: [],
  metadata: {},
  files,
  addedAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
});

describe('moving the library to an account and back', () => {
  it('copies the files the account lacks, then the library, keeping its origin and history', async () => {
    const local = new StoredLibraryBackend(new MemoryTree());
    const { hash, size } = await local.putFile(new Blob(['dune']));
    await local.apply([{ type: 'addItem', item: book('dune', [{ hash, size, format: 'epub' }]) }, { type: 'addTags', id: 'dune', tags: ['sf'] }]);
    const account = fakeAccount();
    const progress: number[] = [];
    await copyToCloud(local, account, (p) => progress.push(p.done));
    expect(progress).toEqual([1]);
    const there = await account.backend.getLibrary();
    expect(there.items.dune?.tags).toEqual(['sf']);
    expect(there.origin).toBe((await local.getLibrary()).origin);
    expect(await account.backend.getChanges(0)).toHaveLength(2);
    expect(await (await account.backend.getFile(hash))?.text()).toBe('dune');
    await expect(copyToCloud(local, account)).rejects.toThrow('has a library already');

    const back = new MemoryTree();
    await copyFromCloud(account, back);
    const home = new StoredLibraryBackend(back);
    expect((await home.getLibrary()).items.dune?.tags).toEqual(['sf']);
    expect(await (await home.getFile(hash))?.text()).toBe('dune');
    expect(await home.getChanges(0)).toHaveLength(2);
    await expect(copyFromCloud(account, back)).rejects.toThrow('has a library of its own');
  });

  it('leaves nothing behind when a file can’t be copied back', async () => {
    const account = fakeAccount();
    const { hash, size } = await account.backend.putFile(new Blob(['dune']));
    await account.backend.apply([{ type: 'addItem', item: book('dune', [{ hash, size, format: 'epub' }]) }]);
    const broken = { ...account, backend: Object.assign(Object.create(account.backend), { getFile: async () => new Blob(['not dune']) }) };
    const back = new MemoryTree();
    await expect(copyFromCloud(broken, back)).rejects.toThrow('arrived changed');
    expect(back.allPaths()).toEqual([]);
  });
});
