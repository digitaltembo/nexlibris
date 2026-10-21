import { createDevice } from '@nexlibris/common';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { DeviceTarget, RemoteFile } from '../../devices/types';
import { readerInventory, readerType as x4 } from '.';
const fixture = () => readFile(join(process.cwd(), '../crosspoint-tools/src/fixtures/library.idx'));

/** A reader whose card has the fixture's index, and these files in the folders a sync lists. */
function reader(listed: Record<string, RemoteFile[]>, index?: Uint8Array<ArrayBuffer>): DeviceTarget {
  return {
    connect: async () => ({ description: 'X4' }),
    list: async (folder) => listed[folder] ?? [],
    ensureFolder: async () => undefined,
    upload: async () => undefined,
    remove: async () => undefined,
    download: async (path) => {
      if (path !== '/.crosspoint/library.idx' || !index) throw new Error('The reader refused /download: Item not found');
      return new Blob([index]);
    },
  };
}

describe('CrossPoint inventory', () => {
  it('lists the card from the reader’s index, newest first, plus files sent since it was built', async () => {
    const index = new Uint8Array(await fixture());
    const murakami = '/books/Haruki Murakami/1Q84 (72)';
    // A sync placed 1Q84 there once, so that folder is listed: and the file has since gone.
    const device = createDevice({ name: 'X4', type: x4.id, settings: { folder: '/books' } });
    device.placed[`${murakami}/1Q84 - Haruki Murakami.x4.epub`] = { itemId: 'i', hash: 'h', size: 1 };
    const target = reader({ '/books': [{ path: '/books/New Book.epub', size: 10 }, { path: '/books/._New Book.epub', size: 1 }], [murakami]: [] }, index);
    const { books, note } = await readerInventory(device, x4, target);
    expect(note).toBeUndefined();
    expect(books[0]).toEqual({ path: '/books/New Book.epub', size: 10 });
    expect(books).toHaveLength(476);
    expect(books.some((book) => book.path.startsWith(murakami))).toBe(false);
    expect(books[1]).toMatchObject({ title: expect.any(String), author: expect.any(String), modified: expect.any(String) });
    expect(books.filter((book) => book.series).length).toBeGreaterThan(0);
  });

  it('falls back to the sync folders’ files, saying why', async () => {
    const device = createDevice({ name: 'X4', type: x4.id });
    const listed = { '/Books': [{ path: '/Books/Dune.epub', size: 5 }] };
    const none = await readerInventory(device, x4, reader(listed));
    expect(none.books).toEqual([{ path: '/Books/Dune.epub', size: 5 }]);
    expect(none.note).toMatch(/couldn’t be read/);

    const old = new Uint8Array(await fixture());
    old[4] = 2;
    expect((await readerInventory(device, x4, reader(listed, old))).note).toMatch(/other firmware/);
  });
});
