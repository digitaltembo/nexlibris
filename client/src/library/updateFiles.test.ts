import JSZip from 'jszip';
import { createItem, LOCAL_USER, MemoryStorage, StoredLibraryBackend, type Item, type Operation } from '@nexlibris/common';
import { describe, expect, it } from 'vitest';
import { epubDrm, parseEpub } from '@nexlibris/tools/formats/epub';
import { buildEpub } from '@nexlibris/tools/formats/epubBuilder';
import { isBehind, metadataKey } from './fileMetadata';
import { findStaleFiles, updateFiles } from './updateFiles';

const epub = (title: string, tags: string[], body = '<p>Hi</p>') =>
  buildEpub({ title, creators: [{ name: 'Frank Herbert', role: 'aut' }], tags, chapters: [{ id: 'c1', title: 'One', body }] });

/** An EPUB with `extra` files added, as DRM or font obfuscation leaves in META-INF. */
async function withFiles(book: Blob, extra: Record<string, string>): Promise<Blob> {
  const zip = await JSZip.loadAsync(await book.arrayBuffer());
  for (const [path, text] of Object.entries(extra)) zip.file(path, text);
  return zip.generateAsync({ type: 'blob' });
}

const encryption = (algorithm: string) =>
  `<encryption xmlns="urn:oasis:names:tc:opendocument:xmlns:container" xmlns:enc="http://www.w3.org/2001/04/xmlenc#">
    <enc:EncryptedData><enc:EncryptionMethod Algorithm="${algorithm}"/><enc:CipherData><enc:CipherReference URI="x"/></enc:CipherData></enc:EncryptedData>
  </encryption>`;

async function library() {
  const backend = new StoredLibraryBackend(new MemoryStorage(), 'Books');
  const stale = await backend.putFile(await epub('Dune', []));
  const x4 = await backend.putFile(await epub('Dune', [], '<p>Optimized</p>'));
  const current = await backend.putFile(await epub('Emma', ['Classic']));
  const dune = createItem({
    title: 'Dune',
    creators: [{ name: 'Frank Herbert', role: 'aut' }],
    tags: ['Science Fiction', '1960s'],
    metadata: { series: 'Dune', seriesIndex: 1 },
    files: [
      { ...stale, format: 'epub', name: 'Dune.epub' },
      { ...x4, format: 'x4.epub', derivedFrom: { hash: stale.hash, converter: 'xteink', converterVersion: '1' } },
      { hash: 'p'.repeat(64), size: 3, format: 'pdf' },
    ],
  });
  const emma = createItem({ title: 'Emma', creators: [{ name: 'Frank Herbert', role: 'aut' }], tags: ['Classic'], files: [{ ...current, format: 'epub' }] });
  const bought = await backend.putFile(await withFiles(await epub('Bought', []), { 'META-INF/rights.xml': '<rights/>' }));
  const protectedItem = createItem({ title: 'Bought', tags: ['Mine'], files: [{ ...bought, format: 'epub' }] });
  const elsewhere = createItem({ title: 'Elsewhere', files: [{ hash: 'f'.repeat(64), size: 1, format: 'epub' }] });
  await backend.apply([
    ...[dune, emma, protectedItem, elsewhere].map((item): Operation => ({ type: 'addItem', item })),
    { type: 'setPosition', userId: LOCAL_USER, itemId: dune.id, position: { hash: stale.hash, locator: 'epubcfi(/6/2)', progress: 0.5 } },
  ]);
  expect(x4.hash).not.toBe(stale.hash);
  return { backend, dune, stale, x4 };
}

describe('updating book files', () => {
  it('finds the EPUBs that differ from the library, and what differs', async () => {
    const { backend, dune } = await library();
    const found = await findStaleFiles(backend, await backend.getLibrary());
    expect(found.stale.map((s) => [s.item.id, s.file.format, s.changes])).toEqual([
      [dune.id, 'epub', ['tags', 'series', 'series index']],
      [dune.id, 'x4.epub', ['tags', 'series', 'series index']],
    ]);
    expect(found).toMatchObject({ current: 1, notHere: 1, drm: [{ title: 'Bought', kind: 'Adobe DRM' }], failed: [] });
  });

  it('writes them, moving converted files, positions and the text index to the new files', async () => {
    const { backend, dune, stale, x4 } = await library();
    const found = await findStaleFiles(backend, await backend.getLibrary());
    const carried: string[][] = [];
    const result = await updateFiles(backend, found.stale, (ops) => backend.apply(ops), {
      carryText: async (from, to) => void carried.push([from, to]),
    });
    expect(result).toMatchObject({ updated: 2, freed: 2, failed: [] });

    const after = await backend.getLibrary();
    const item: Item = after.items[dune.id]!;
    const book = item.files.find((f) => f.format === 'epub')!;
    const converted = item.files.find((f) => f.format === 'x4.epub')!;
    expect(book).toMatchObject({ name: 'Dune.epub' });
    expect(book.hash).not.toBe(stale.hash);
    expect(converted.derivedFrom).toEqual({ hash: book.hash, converter: 'xteink', converterVersion: '1' });
    expect(item.files.map((f) => f.format).sort()).toEqual(['epub', 'pdf', 'x4.epub']);
    expect(after.userData[LOCAL_USER]!.positions![dune.id]).toMatchObject({ hash: book.hash, locator: 'epubcfi(/6/2)', progress: 0.5 });
    expect(carried).toEqual([
      [stale.hash, book.hash],
      [x4.hash, converted.hash],
    ]);
    expect(await backend.hasFile(stale.hash)).toBe(false);
    expect(await parseEpub((await backend.getFile(book.hash))!)).toMatchObject({
      tags: ['Science Fiction', '1960s'],
      metadata: { series: 'Dune', seriesIndex: 1 },
    });

    // Now everything matches.
    expect((await findStaleFiles(backend, after)).stale).toEqual([]);
  });

  it('tells DRM from the font obfuscation publishers use without it', async () => {
    const book = await epub('Dune', []);
    expect(await epubDrm(book)).toBeUndefined();
    expect(await epubDrm(await withFiles(book, { 'META-INF/encryption.xml': encryption('http://www.idpf.org/2008/embedding') }))).toBeUndefined();
    expect(await epubDrm(await withFiles(book, { 'META-INF/encryption.xml': encryption('http://www.w3.org/2001/04/xmlenc#aes128-cbc') }))).toBe('encrypted');
    expect(await epubDrm(await withFiles(book, { 'META-INF/sinf.xml': '<sinf/>' }))).toBe('Apple DRM');
  });
});

describe('updating book files’ covers', () => {
  const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
  const bytes = async (blob: Blob | undefined) => [...new Uint8Array(await blob!.arrayBuffer())];

  /** Dune, whose EPUB has no cover and whose X4 copy, converted from it, has none either, given a cover in the library. */
  async function withCover() {
    const backend = new StoredLibraryBackend(new MemoryStorage(), 'Books');
    const book = await backend.putFile(await epub('Dune', []));
    const x4 = await backend.putFile(await epub('Dune', [], '<p>Optimized</p>'));
    const cover = await backend.putFile(new Blob([JPEG]));
    const dune = createItem({
      title: 'Dune',
      creators: [{ name: 'Frank Herbert', role: 'aut' }],
      cover: { hash: cover.hash, mediaType: 'image/jpeg' },
      files: [
        { ...book, format: 'epub', name: 'Dune.epub' },
        { ...x4, format: 'x4.epub', derivedFrom: { hash: book.hash, converter: 'xteink', converterVersion: '1' } },
      ],
    });
    await backend.apply([{ type: 'addItem', item: dune }]);
    return { backend, dune, cover };
  }

  it('finds a file whose cover isn’t the library’s, and writes it, but not into converted copies', async () => {
    const { backend, dune } = await withCover();
    const found = await findStaleFiles(backend, await backend.getLibrary());
    expect(found.stale.map((s) => [s.file.format, s.changes])).toEqual([['epub', ['cover']]]);

    expect(await updateFiles(backend, found.stale, (ops) => backend.apply(ops))).toMatchObject({ updated: 1, failed: [] });
    const item = (await backend.getLibrary()).items[dune.id]!;
    const book = item.files.find((f) => f.format === 'epub')!;
    const parsed = await parseEpub((await backend.getFile(book.hash))!);
    expect(parsed.cover?.mediaType).toBe('image/jpeg');
    expect(await bytes(parsed.cover?.data)).toEqual([...JPEG]);
    expect(book.metadataKey).toBe(metadataKey(item, book));
    expect((await findStaleFiles(backend, await backend.getLibrary())).stale).toEqual([]);
  });

  it('counts a file behind once its cover is changed, unless its fingerprint is from before covers were written', async () => {
    const { dune } = await withCover();
    const book = dune.files[0]!;
    const recolored = { ...dune, cover: { hash: 'b'.repeat(64), mediaType: 'image/jpeg' } };
    expect(isBehind(dune, { ...book, metadataKey: metadataKey(dune, book) })).toBe(false);
    expect(isBehind(recolored, { ...book, metadataKey: metadataKey(dune, book) })).toBe(true);
    // A fingerprint without the cover's part knows only the rest.
    expect(isBehind(recolored, { ...book, metadataKey: metadataKey(dune) })).toBe(false);
    // Converted copies keep their own cover, so theirs isn't part of their fingerprint.
    const x4 = dune.files[1]!;
    expect(metadataKey(dune, x4)).toBe(metadataKey(dune));
  });
});
