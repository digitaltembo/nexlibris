import { MemoryStorage, StoredLibraryBackend } from '@nexlibris/common';
import { describe, expect, it } from 'vitest';
import { coverThumbnail, thumbnailPath } from './thumbnails';

describe('coverThumbnail', () => {
  const setup = async () => {
    const storage = new MemoryStorage();
    const backend = new StoredLibraryBackend(storage);
    const { hash } = await backend.putFile(new Blob(['full-size cover']));
    const made: string[] = [];
    const make = async (image: Blob) => {
      made.push(await image.text());
      return new Blob(['thumbnail'], { type: 'image/jpeg' });
    };
    return { storage, backend, cover: { hash, mediaType: 'image/png' as const }, made, make };
  };

  it('makes a thumbnail once, keeps it in local files, and reads it back after', async () => {
    const { storage, backend, cover, made, make } = await setup();
    // Asked for twice at once (two covers of one book on screen): made once.
    const [first, second] = await Promise.all([coverThumbnail(backend, cover, make), coverThumbnail(backend, cover, make)]);
    expect(await first?.text()).toBe('thumbnail');
    expect(await second?.text()).toBe('thumbnail');
    expect(made).toEqual(['full-size cover']);
    expect(await storage.exists(`local/${thumbnailPath(cover.hash)}`)).toBe(true);

    const again = await coverThumbnail(new StoredLibraryBackend(storage), cover, make);
    expect([await again?.text(), again?.type]).toEqual(['thumbnail', 'image/jpeg']);
    expect(made).toHaveLength(1);
  });

  it("shows the cover itself when it can't be shrunk, and keeps nothing", async () => {
    const { storage, backend, cover } = await setup();
    const shown = await coverThumbnail(backend, cover, async () => {
      throw new Error("can't decode");
    });
    expect([await shown?.text(), shown?.type]).toEqual(['full-size cover', 'image/png']);
    expect(await storage.exists(`local/${thumbnailPath(cover.hash)}`)).toBe(false);
  });

  it("gives nothing for a cover that isn't stored", async () => {
    const { backend, make } = await setup();
    expect(await coverThumbnail(backend, { hash: 'ab'.repeat(32), mediaType: 'image/jpeg' }, make)).toBeUndefined();
  });
});
