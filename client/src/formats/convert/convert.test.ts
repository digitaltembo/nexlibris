import { createItem } from '@nexlibris/common';
import JSZip from 'jszip';
import { mkdtemp, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openComic } from '../comic';
import { parseEpub } from '../epub';
import { kindleToEpub, parseKindle, type KindleOptions } from '../kindle';
import { cbrToCbz, comicToEpub } from './comics';
import { epubToTxt, textChapters, textParagraphs, txtToEpub } from './text';

// happy-dom rewrites import.meta.url, so resolve from the package root vitest runs in.
const fixture = async (name: string) => new Blob([await readFile(join(process.cwd(), 'src/formats/fixtures', name))]);

async function unrarWasm(): Promise<ArrayBuffer> {
  const bytes = await readFile(createRequire(join(process.cwd(), 'package.json')).resolve('node-unrar-js/esm/js/unrar.wasm'));
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

/** Under Node the parser writes resources to disk and hands back paths, so read those. */
async function nodeKindleOptions(): Promise<KindleOptions> {
  return {
    resourceSaveDir: await mkdtemp(join(tmpdir(), 'nexlibris-kindle-')),
    fetchResource: async (path) => {
      const ext = path.split('.').pop()!;
      const mediaType = { jpg: 'image/jpeg', png: 'image/png', css: 'text/css' }[ext] ?? 'application/octet-stream';
      return { data: new Uint8Array(await readFile(path)), mediaType };
    },
  };
}

async function epubEntries(epub: Blob) {
  const zip = await JSZip.loadAsync(await epub.arrayBuffer());
  const text = async (path: string) => (await zip.file(path)?.async('string')) ?? '';
  return { zip, names: Object.keys(zip.files), text };
}

const item = createItem({
  title: 'Edited Title',
  creators: [{ name: 'Library Author', role: 'aut' }],
  tags: ['From Library'],
  metadata: { series: 'Test Series', seriesIndex: 2, language: 'en' },
});

// sample.mobi (old MOBI) and sample.azw3 (KF8) were made by Calibre from a two-chapter
// EPUB with a stylesheet, an image, a cover and a link from chapter one to chapter two.
describe.each(['sample.mobi', 'sample.azw3'])('%s', (name) => {
  it('reads metadata and cover', async () => {
    const parsed = await parseKindle(await fixture(name), name, await nodeKindleOptions());
    expect(parsed).toMatchObject({
      title: 'The Kindle Sample',
      creators: [{ name: 'Mo Bee', role: 'aut' }],
      tags: ['Testing'],
      metadata: { publisher: 'Sample Press', language: 'en' },
    });
    expect(parsed.cover?.mediaType).toMatch(/^image\//);
  });

  it('converts to an EPUB with the library metadata, chapters, images and working links', async () => {
    const epub = await kindleToEpub(await fixture(name), { item }, await nodeKindleOptions());
    const reparsed = await parseEpub(epub);
    expect(reparsed).toMatchObject({
      title: 'Edited Title',
      creators: [{ name: 'Library Author', role: 'aut' }],
      tags: ['From Library'],
      metadata: { series: 'Test Series', seriesIndex: 2 },
    });

    const { names, text } = await epubEntries(epub);
    const chapters = names.filter((n) => /^OEBPS\/text\/.+\.xhtml$/.test(n)).sort();
    const contents = await Promise.all(chapters.map(text));
    const one = contents.find((c) => c.includes('first'))!;
    const two = contents.find((c) => c.includes('The second chapter'))!;
    expect(one).toBeDefined();
    expect(two).toBeDefined();

    // The image is packaged and referenced relatively.
    const imgSrc = /<img[^>]+src="\.\.\/(images\/[^"]+)"/.exec(one)?.[1];
    expect(imgSrc && names).toContain(`OEBPS/${imgSrc}`);
    // The cross-chapter link points at chapter two's file.
    const href = /<a[^>]+href="\.\.\/(text\/[^"#]+)/.exec(one)?.[1];
    expect(contents[chapters.indexOf(`OEBPS/${href}`)]).toBe(two);
    // Every chapter is well-formed XML.
    for (const c of contents) {
      expect(new DOMParser().parseFromString(c, 'application/xml').getElementsByTagName('parsererror')).toHaveLength(0);
    }
    expect(await text('OEBPS/nav.xhtml')).toContain('Chapter Two');
  });
});

describe('plain text', () => {
  it('unwraps hard-wrapped paragraphs and keeps one-per-line text', () => {
    expect(textParagraphs('One line\nwrapped here.\n\nSecond para.')).toEqual(['One line wrapped here.', 'Second para.']);
    expect(textParagraphs('First.\nSecond.\nThird.')).toEqual(['First.', 'Second.', 'Third.']);
  });

  it('splits chapters at headings', () => {
    const chapters = textChapters(['Intro text.', 'Chapter 1', 'Alpha.', 'Beta.', 'CHAPTER II. The Return', 'IV', 'Gamma.'], 'Book');
    expect(chapters).toEqual([
      { title: 'Book', paragraphs: ['Intro text.'] },
      { title: 'Chapter 1', paragraphs: ['Alpha.', 'Beta.'] },
      { title: 'CHAPTER II. The Return', paragraphs: [] },
      { title: 'IV', paragraphs: ['Gamma.'] },
    ]);
  });

  it('round-trips through EPUB and back to text', async () => {
    const source = new Blob(['Chapter 1\n\nIt was a <dark> & stormy night.\n\nChapter 2\n\nThe end.']);
    const epub = await txtToEpub(source, { item });
    expect((await parseEpub(epub)).title).toBe('Edited Title');
    const text = await (await epubToTxt(epub, { item })).text();
    expect(text).toContain('It was a <dark> & stormy night.');
    expect(text.indexOf('Chapter 1')).toBeLessThan(text.indexOf('Chapter 2'));
  });
});

describe('comics', () => {
  it('repackages a CBR as a CBZ with the same pages', async () => {
    const wasm = await unrarWasm();
    const cbz = await cbrToCbz(await fixture('sample.cbr'), { item }, { unrarWasm: wasm });
    const comic = await openComic('cbz', cbz);
    expect(comic.pages.map((p) => p.name.split('/').pop())).toEqual(['page1.png', 'page2.png', 'page10.png']);
    expect(comic.comicInfo).toContain('The Test Issue');
  });

  it('makes an image-per-page EPUB', async () => {
    const epub = await comicToEpub('cbz', await fixture('sample.cbz'), { item });
    const { names } = await epubEntries(epub);
    expect(names.filter((n) => /^OEBPS\/text\/.+\.xhtml$/.test(n))).toHaveLength(3);
    expect(names.filter((n) => /OEBPS\/images\/p\d+\.png/.test(n))).toHaveLength(3);
  });
});
