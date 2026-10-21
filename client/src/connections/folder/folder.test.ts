import { createDevice, createItem, MemoryStorage, StoredLibraryBackend, type FileRef } from '@nexlibris/common';
import { describe, expect, it, vi } from 'vitest';
import { connectionContents, importFromConnection } from '../../devices/contents';
import { listDevice, planSync } from '../../devices/plan';
import { runSync } from '../../devices/run';
import type { DeviceTarget, RemoteFile } from '../../devices/types';
import { folderType } from '.';
import { MANIFEST_PATH, readManifest } from './manifest';

// Under Node the Kindle parser fetches resources; nothing here imports Kindle files.
vi.mock('@nexlibris/tools/formats/kindle', () => ({}));

/** A folder as a map of path to contents. */
class FakeFolder implements DeviceTarget {
  files = new Map<string, Blob>();
  async connect() {
    return { description: 'a folder' };
  }
  async list(folder: string): Promise<RemoteFile[]> {
    return [...this.files]
      .filter(([path]) => path.slice(0, path.lastIndexOf('/')) === folder.replace(/\/$/, ''))
      .map(([path, data]) => ({ path, size: data.size }));
  }
  async ensureFolder() {}
  async upload(path: string, data: Blob) {
    this.files.set(path, data);
  }
  async remove(path: string) {
    this.files.delete(path);
  }
  async download(path: string) {
    const data = this.files.get(path);
    if (!data) throw new Error(`no ${path}`);
    return data;
  }
}

async function library(name: string) {
  const backend = new StoredLibraryBackend(new MemoryStorage(), name);
  return backend;
}

describe('folder connection', () => {
  it('writes every format a book has by its save path, with a manifest another library reads it back from', async () => {
    const backend = await library('Mine');
    const refs: FileRef[] = [];
    for (const [format, text] of [['epub', 'dune epub'], ['x4.epub', 'dune x4']] as const) {
      const { hash, size } = await backend.putFile(new Blob([text]));
      refs.push({ hash, size, format });
    }
    const cover = await backend.putFile(new Blob(['a cover']));
    const dune = createItem({
      title: 'Dune',
      creators: [{ name: 'Frank Herbert', role: 'aut' }],
      tags: ['sci-fi'],
      files: refs,
      cover: { hash: cover.hash, mediaType: 'image/png' },
    });
    const device = createDevice({ name: 'USB', type: folderType.id });
    await backend.apply([{ type: 'addItem', item: dune }, { type: 'addDevice', device }, { type: 'addDeviceItems', id: device.id, itemIds: [dune.id] }]);
    const folder = new FakeFolder();

    const before = await backend.getLibrary();
    const current = before.devices![device.id]!;
    const plan = planSync(before, current, folderType, await listDevice(current, folderType, folder, before));
    await backend.apply((await runSync(before, current, plan, folder, backend)).operations);
    const after = await backend.getLibrary();
    await folderType.afterSync!(after.devices![device.id]!, folder, after, backend);

    expect([...folder.files.keys()].filter((path) => !path.startsWith('/.')).sort()).toEqual(['/Herbert, Frank/Dune.epub', '/Herbert, Frank/Dune.x4.epub']);
    const manifest = await readManifest(folder);
    expect(manifest?.books).toMatchObject([{ item: { id: dune.id, title: 'Dune' }, cover: { mediaType: 'image/png' } }]);
    expect(manifest?.books[0]!.files.map((f) => f.format).sort()).toEqual(['epub', 'x4.epub']);
    expect(folder.files.has(MANIFEST_PATH)).toBe(true);

    // Another library reads it: the books with their details, and brings one in as it was.
    const other = await library('Other');
    const otherDevice = createDevice({ name: 'USB', type: folderType.id });
    await other.apply([{ type: 'addDevice', device: otherDevice }]);
    const inventory = await folderType.inventory!(otherDevice, folder, await other.getLibrary(), [...folder.files].map(([path, data]) => ({ path, size: data.size })));
    expect(inventory.books.find((b) => b.path.endsWith('Dune.epub'))).toMatchObject({ title: 'Dune', author: 'Frank Herbert', tags: ['sci-fi'] });
    const contents = connectionContents(await other.getLibrary(), otherDevice, folderType, inventory.books);
    expect(contents.entries.every((e) => e.kind === 'unknown')).toBe(true);
    const book = inventory.books.find((b) => b.path.endsWith('Dune.epub'))!;
    const { item, linked } = await importFromConnection(other, otherDevice, folderType, folder, book);
    expect(item).toMatchObject({ id: dune.id, title: 'Dune', tags: ['sci-fi'] });
    expect(item.cover?.mediaType).toBe('image/png');
    expect(await other.hasFile(item.cover!.hash)).toBe(true);
    expect(linked).toBe(true);
    // The second format joins the same book.
    const x4 = inventory.books.find((b) => b.path.endsWith('Dune.x4.epub'))!;
    const again = await importFromConnection(other, (await other.getLibrary()).devices![otherDevice.id]!, folderType, folder, x4);
    expect(again.item.files.map((f) => f.format).sort()).toEqual(['epub', 'x4.epub']);
  });
});
