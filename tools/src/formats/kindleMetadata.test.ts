import { initKf8File, initMobiFile } from '@lingo-reader/mobi-parser';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { EpubMetadata } from './epubMetadata';
import { readKindleHeader } from './kindleHeader';
import { writeKindleMetadata } from './kindleMetadata';

// happy-dom rewrites import.meta.url, so resolve from the package root vitest runs in.
const fixture = async (name: string) => new Uint8Array(await readFile(join(process.cwd(), 'src/formats/fixtures', name)));
const bytesOf = async (blob: Blob) => new Uint8Array(await blob.arrayBuffer());

const EDITS: EpubMetadata = {
  title: 'A Café Called “Elsewhere”',
  creators: [
    { name: 'Ursula K. Le Guin', role: 'aut' },
    { name: 'Frank Herbert', role: 'aut' },
    { name: 'Ed Itor', role: 'edt' },
  ],
  tags: ['Fantasy', 'Classics'],
  publisher: 'Elsewhere Press',
  description: '<p>Tea, and <b>other</b> things.</p>',
  published: '1971-03-04',
  language: 'fr',
};

/** Each chapter's HTML as lingo-reader reads it, KF8's or the old MOBI's, resources saved to `dir`. */
async function chapters(bytes: Uint8Array, kind: 'kf8' | 'mobi', dir: string) {
  const book = kind === 'kf8' ? await initKf8File(bytes, dir) : await initMobiFile(bytes, dir);
  try {
    return { metadata: book.getMetadata(), html: book.getSpine().map((c) => book.loadChapter(c.id)?.html) };
  } finally {
    book.destroy();
  }
}

describe.each([
  ['sample.mobi', ['mobi']],
  ['sample.azw3', ['kf8']],
  ['sample-joint.mobi', ['mobi', 'kf8']],
] as const)('writeKindleMetadata on %s', (name, kinds) => {
  it('writes the metadata into the padding, leaving the text, identifiers and cover as they were', async () => {
    const original = await fixture(name);
    const written = await bytesOf(await writeKindleMetadata(new Blob([original]), EDITS));
    expect(written.length).toBe(original.length);

    const before = readKindleHeader(original);
    expect(readKindleHeader(written)).toEqual({
      ...before,
      title: EDITS.title,
      authors: ['Ursula K. Le Guin', 'Frank Herbert'],
      subjects: ['Fantasy', 'Classics'],
      publisher: 'Elsewhere Press',
      description: EDITS.description,
      published: '1971-03-04',
      language: 'fr',
    });

    const dir = await mkdtemp(join(tmpdir(), 'nexlibris-kindle-'));
    for (const kind of kinds) {
      const old = await chapters(original, kind, dir);
      const now = await chapters(written, kind, dir);
      expect(now.html).toEqual(old.html);
      expect(now.html.length).toBeGreaterThan(0);
      expect(now.metadata).toMatchObject({ title: EDITS.title, author: ['Ursula K. Le Guin', 'Frank Herbert'], subject: ['Fantasy', 'Classics'] });
    }
  });

  it('moves the records along when the metadata outgrows the padding', async () => {
    const original = await fixture(name);
    const description = `<p>${'A long description. '.repeat(1500)}</p>`;
    const written = await bytesOf(await writeKindleMetadata(new Blob([original]), { ...EDITS, description }));
    expect(written.length).toBeGreaterThan(original.length);
    expect(readKindleHeader(written)).toMatchObject({ title: EDITS.title, description, cover: readKindleHeader(original).cover });

    const dir = await mkdtemp(join(tmpdir(), 'nexlibris-kindle-'));
    for (const kind of kinds) {
      expect((await chapters(written, kind, dir)).html).toEqual((await chapters(original, kind, dir)).html);
    }
    // And again, now that there's room to spare.
    const again = await bytesOf(await writeKindleMetadata(new Blob([written]), { ...EDITS, title: 'Shorter' }));
    expect(again.length).toBe(written.length);
    expect(readKindleHeader(again).title).toBe('Shorter');
  });
});

describe('writeKindleMetadata', () => {
  it('leaves what it isn’t given as the file has it, and a language the file says in another form', async () => {
    const original = await fixture('sample.azw3');
    const before = readKindleHeader(original);
    const written = readKindleHeader(await bytesOf(await writeKindleMetadata(new Blob([original]), { title: 'Only the Title', creators: [], language: 'eng' })));
    expect(written).toEqual({ ...before, title: 'Only the Title' });
  });

  it('writes Windows-1252 in a file that uses it', async () => {
    const original = await fixture('sample.mobi');
    const view = new DataView(original.buffer);
    view.setUint32(view.getUint32(78) + 28, 1252);
    const written = readKindleHeader(await bytesOf(await writeKindleMetadata(new Blob([original]), { ...EDITS, title: 'Café “Quoted” ✓' })));
    expect(written.title).toBe('Café “Quoted” ?');
  });

  it('refuses a file with DRM, or that isn’t a Kindle book', async () => {
    const locked = await fixture('sample.mobi');
    const view = new DataView(locked.buffer);
    view.setUint16(view.getUint32(78) + 12, 2);
    await expect(writeKindleMetadata(new Blob([locked]), EDITS)).rejects.toThrow('DRM-protected');
    await expect(writeKindleMetadata(new Blob(['not a book']), EDITS)).rejects.toThrow('Not a readable MOBI/AZW file');
  });
});
