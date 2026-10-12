import { MemoryStorage } from '@nexlibris/common';
import { describe, expect, it } from 'vitest';
import { relocate, type Tree } from './libraryFolder';

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
