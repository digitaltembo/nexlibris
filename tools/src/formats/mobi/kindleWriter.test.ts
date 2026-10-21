import { initKf8File, initMobiFile } from '@lingo-reader/mobi-parser';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ConvertContext } from '../convert/bookFromItem';
import { buildEpub } from '../epubBuilder';
import { readKindleHeader } from '../kindleHeader';
import { readEpubPackage } from './epub';
import { writeKf8 } from './kf8';
import { writeMobi6 } from './mobi6';
import { compressPalmDoc, decompressPalmDoc } from './palmdoc';
import { textRecords } from './records';

const PNG = Uint8Array.from(
  atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='),
  (c) => c.charCodeAt(0),
);

const ctx: ConvertContext = {
  item: {
    title: 'The Kindle Test',
    creators: [{ name: 'Ann Author', role: 'aut' }, { name: 'Ed Itor', role: 'edt' }],
    identifiers: { isbn: '9780000000001', uuid: '0f2b4c38-8c34-4bb2-9a6e-3c4b8e8f1d11' },
    tags: ['Testing', 'Fiction'],
    metadata: { publisher: 'Test Press', description: '<p>A <b>book</b>.</p>', published: '2001-02-03', language: 'en' },
  },
};

/** A paragraph long enough that chapters need several fragments. */
const filler = (n: number, word: string) => Array.from({ length: n }, (_, i) => `<p id="${word}${i}">${word} ${i} – ${'café naïve '.repeat(40)}</p>`).join('');

async function sampleEpub() {
  return buildEpub({
    title: 'Source title',
    creators: [{ name: 'Someone Else', role: 'aut' }],
    chapters: [
      {
        id: 'c1',
        title: 'One',
        body: `<h1 id="start">Chapter One</h1><p class="first">See <a href="c2.xhtml#deep">the second chapter</a> and <a href="https://example.com/">a site</a>.</p><p><img src="../images/dot.png" alt="a dot"/></p>${filler(30, 'one')}`,
        stylesheets: ['styles/book.css'],
      },
      {
        id: 'c2',
        title: 'Two',
        body: `<h1>Chapter Two</h1>${filler(5, 'two')}<div><p id="deep">Deep inside.</p></div><table><tr><td id="cell">A cell</td></tr></table>`,
        stylesheets: ['styles/book.css'],
      },
    ],
    resources: [
      { path: 'images/dot.png', mediaType: 'image/png', data: PNG },
      { path: 'styles/book.css', mediaType: 'text/css', data: 'p.first { font-style: italic } h1 { background: url(../images/dot.png) }' },
    ],
    toc: [
      { label: 'One', href: 'text/c1.xhtml', children: [{ label: 'Start', href: 'text/c1.xhtml#start' }] },
      { label: 'Two', href: 'text/c2.xhtml', children: [{ label: 'Deep', href: 'text/c2.xhtml#deep' }] },
    ],
  });
}

describe('PalmDOC', () => {
  it('compresses so that it decompresses to the same bytes', () => {
    const text = new TextEncoder().encode(`${'<p>Hello, hello, hello world. </p>'.repeat(80)}\u0001\u0002ÿ tail`);
    const record = text.subarray(0, 4096);
    const compressed = compressPalmDoc(record);
    expect(compressed.length).toBeLessThan(record.length / 3);
    expect(decompressPalmDoc(compressed)).toEqual(record);
    const random = Uint8Array.from({ length: 4096 }, (_, i) => (i * 7919) % 251);
    expect(decompressPalmDoc(compressPalmDoc(random))).toEqual(random);
  });

  it('splits text into records, carrying the bytes of a character a record cuts off', () => {
    const text = new TextEncoder().encode(`${'a'.repeat(4095)}€${'b'.repeat(10)}`);
    const { records, lengths } = textRecords(text);
    expect(lengths).toEqual([4096, 12]);
    // The euro sign's three bytes start at 4095, so two follow the first record's text, then their count.
    const first = records[0]!;
    expect(first.at(-1)).toBe(2);
    expect([...first.subarray(-3, -1)]).toEqual([0x82, 0xac]);
  });
});

describe('writeKf8', () => {
  it('writes an AZW3 that Kindle readers read: metadata, cover, chapters, links and images', async () => {
    const kf8 = await writeKf8(await readEpubPackage(await sampleEpub()), ctx);
    const bytes = new Uint8Array(await kf8.arrayBuffer());
    expect(readKindleHeader(bytes)).toMatchObject({
      title: 'The Kindle Test',
      authors: ['Ann Author'],
      publisher: 'Test Press',
      subjects: ['Testing', 'Fiction'],
      isbn: '9780000000001',
      published: '2001-02-03',
      language: 'en',
      encrypted: false,
    });

    const dir = await mkdtemp(join(tmpdir(), 'nexlibris-kf8-'));
    await writeFile(join(dir, 'book.azw3'), bytes);
    const book = await initKf8File(bytes, dir);
    try {
      const html = book.getSpine().map((c) => book.loadChapter(c.id)?.html ?? '').join('\n');
      expect(html).toContain('Chapter One');
      expect(html).toContain('one 29');
      expect(html).toContain('Deep inside.');
      expect(html).toContain('café naïve');
      expect(html).toContain('https://example.com/');
      expect(book.getToc().map((t) => t.label)).toEqual(['One', 'Two']);
    } finally {
      book.destroy();
    }
  });
});

describe('writeMobi6', () => {
  it('writes a MOBI that Kindle readers read, its CSS as Mobipocket markup and its links as offsets', async () => {
    const mobi = await writeMobi6(await readEpubPackage(await sampleEpub()), ctx);
    const bytes = new Uint8Array(await mobi.arrayBuffer());
    expect(readKindleHeader(bytes)).toMatchObject({ title: 'The Kindle Test', authors: ['Ann Author'], isbn: '9780000000001', language: 'en' });

    const dir = await mkdtemp(join(tmpdir(), 'nexlibris-mobi-'));
    const book = await initMobiFile(bytes, dir);
    try {
      const html = book.getSpine().map((c) => book.loadChapter(c.id)?.html ?? '').join('\n');
      expect(html).toContain('Deep inside.');
      expect(html).toContain('café naïve');
      // p.first's italic, from the stylesheet.
      expect(html).toMatch(/<i>See /);
      // From the contents page written for it (lingo-reader reads its top level).
      expect(book.getToc().map((t) => t.label)).toEqual(['One', 'Two']);
    } finally {
      book.destroy();
    }
    // The link to #deep is the offset where that paragraph starts.
    const text = new TextDecoder().decode(bytes);
    expect(text).not.toContain('filepos=0000000000');
  });
});
