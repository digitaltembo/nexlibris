import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import { crc32, readZip, zipParts, type ZipEntryInput } from './zip';

const collect = async (entries: ZipEntryInput[], options?: Parameters<typeof zipParts>[1]) => {
  const parts: (Uint8Array | Blob)[] = [];
  for await (const part of zipParts(entries, options)) parts.push(part);
  return { parts, zip: new Blob(parts as BlobPart[]) };
};

const book = new Blob([new Uint8Array(5000).map((_, i) => (i * 7) % 251)]);
const entries = (): ZipEntryInput[] => [
  { name: 'manifest.json', data: JSON.stringify({ hello: 'wörld', list: Array.from({ length: 50 }, (_, i) => i) }) },
  { name: 'files/abc', data: book },
  { name: 'files/empty', data: new Blob([]) },
  { name: 'ünïcode/名前.txt', data: new Blob(['text']) },
];

describe('zip', () => {
  it('computes CRC-32', () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
  });

  it('passes stored data through as the caller’s own Blobs', async () => {
    const { parts } = await collect(entries());
    expect(parts).toContain(book);
  });

  for (const [label, options] of [
    ['plain', {}],
    ['ZIP64', { zip64Above: 10 }],
  ] as const) {
    it(`writes zips other tools read, and reads them back (${label})`, async () => {
      const { zip } = await collect(entries(), options);

      const read = await readZip(zip);
      expect([...read.keys()]).toEqual(entries().map((e) => e.name));
      expect(JSON.parse(await read.get('manifest.json')!.text()).hello).toBe('wörld');
      expect(new Uint8Array(await (await read.get('files/abc')!.blob()).arrayBuffer())).toEqual(
        new Uint8Array(await book.arrayBuffer()),
      );
      expect((await read.get('files/empty')!.blob()).size).toBe(0);
      expect(await read.get('ünïcode/名前.txt')!.text()).toBe('text');

      // JSZip checks CRCs as it reads.
      const other = await JSZip.loadAsync(await zip.arrayBuffer(), { checkCRC32: true });
      expect(await other.file('ünïcode/名前.txt')!.async('string')).toBe('text');
      expect((await other.file('files/abc')!.async('uint8array')).length).toBe(5000);
      expect(JSON.parse(await other.file('manifest.json')!.async('string')).list).toHaveLength(50);
    });
  }

  it('reads zips JSZip wrote, deflated or stored, with a comment', async () => {
    const zip = new JSZip();
    zip.file('a.txt', 'deflated '.repeat(100), { compression: 'DEFLATE' });
    zip.file('b.bin', new Uint8Array([1, 2, 3]));
    const blob = await zip.generateAsync({ type: 'blob', compression: 'STORE', comment: 'a comment' });
    const read = await readZip(blob);
    expect(await read.get('a.txt')!.text()).toBe('deflated '.repeat(100));
    expect(new Uint8Array(await (await read.get('b.bin')!.blob()).arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
  });

  it('says when a file isn’t a zip', async () => {
    await expect(readZip(new Blob(['not a zip at all']))).rejects.toThrow('Not a zip file.');
  });
});
