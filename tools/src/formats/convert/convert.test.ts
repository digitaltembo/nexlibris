import JSZip from 'jszip';
import { mkdtemp, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openComic } from '../comic';
import { parseEpub } from '../epub';
import { kindleToEpub, MAX_CONVERT_TEXT, parseKindle, type KindleOptions } from '../kindle';
import type { ConvertItem } from './bookFromItem';
import { conversionPath, conversionPaths, pathFidelity, pathOptions, pathWithOptions } from './converters';
import { cbrToCbz, cbzToCbr, comicToEpub } from './comics';
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

const item: ConvertItem = {
  title: 'Edited Title',
  creators: [{ name: 'Library Author', role: 'aut' }],
  identifiers: {},
  tags: ['From Library'],
  metadata: { series: 'Test Series', seriesIndex: 2, language: 'en' },
};

// sample.mobi (old MOBI) and sample.azw3 (KF8) were made by Calibre from a two-chapter
// EPUB with a stylesheet, an image, a cover and a link from chapter one to chapter two.
describe.each(['sample.mobi', 'sample.azw3'])('%s', (name) => {
  it('reads metadata and cover', async () => {
    const parsed = await parseKindle(await fixture(name), name);
    expect(parsed).toMatchObject({
      title: 'The Kindle Sample',
      creators: [{ name: 'Mo Bee', role: 'aut' }],
      tags: ['Testing'],
      identifiers: { isbn: '9780000000002' },
      metadata: { publisher: 'Sample Press', language: 'en', published: '2026-10-01' },
    });
    expect(parsed.cover?.mediaType).toMatch(/^image\//);
    expect((await parsed.cover!.data.arrayBuffer()).byteLength).toBeGreaterThan(1000);
  });

  /** The fixture with its first record's PalmDOC header changed: `at` bytes in, a `size`-byte number. */
  const withHeader = async (at: number, size: 2 | 4, value: number) => {
    const bytes = new Uint8Array(await (await fixture(name)).arrayBuffer());
    const view = new DataView(bytes.buffer);
    const first = view.getUint32(78);
    if (size === 2) view.setUint16(first + at, value);
    else view.setUint32(first + at, value);
    return new Blob([bytes]);
  };

  it('refuses a DRM-protected book rather than reading its scrambled text', async () => {
    const locked = await withHeader(12, 2, 2);
    await expect(parseKindle(locked, name)).rejects.toThrow('DRM-protected');
    await expect(kindleToEpub(locked, { item }, await nodeKindleOptions())).rejects.toThrow('DRM-protected');
  });

  it('refuses to convert a book with more text than the app can hold', async () => {
    const huge = await withHeader(4, 4, MAX_CONVERT_TEXT + 1);
    await expect(kindleToEpub(huge, { item }, await nodeKindleOptions())).rejects.toThrow('too big to convert');
    // Its metadata is still read, so it's imported as it is.
    expect((await parseKindle(huge, name)).title).toBe('The Kindle Sample');
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

  it('repackages a CBZ as a CBR that unrar reads, pages and ComicInfo.xml byte for byte', async () => {
    const cbz = await openComic('cbz', await fixture('sample.cbz'));
    const cbr = await cbzToCbr(await fixture('sample.cbz'), { item });
    expect([...new Uint8Array(await cbr.slice(0, 8).arrayBuffer())]).toEqual([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x01, 0x00]);
    const comic = await openComic('cbr', cbr, { unrarWasm: await unrarWasm() });
    expect(comic.pages.map((p) => p.name)).toEqual(cbz.pages.map((p) => p.name));
    for (const [i, page] of comic.pages.entries()) {
      expect(new Uint8Array(await (await page.load()).arrayBuffer())).toEqual(new Uint8Array(await (await cbz.pages[i]!.load()).arrayBuffer()));
    }
    expect(comic.comicInfo).toBe(cbz.comicInfo);
  });

  it('makes an image-per-page EPUB', async () => {
    const epub = await comicToEpub('cbz', await fixture('sample.cbz'), { item });
    const { names } = await epubEntries(epub);
    expect(names.filter((n) => /^OEBPS\/text\/.+\.xhtml$/.test(n))).toHaveLength(3);
    expect(names.filter((n) => /OEBPS\/images\/p\d+\.png/.test(n))).toHaveLength(3);
  });
});

describe('conversion paths', () => {
  it('reaches formats by the paths that lose least, the least lossy first', () => {
    const paths = conversionPaths('mobi');
    expect(paths.has('mobi')).toBe(false);
    expect(paths.get('epub')?.map((c) => c.id)).toEqual(['kindle-epub']);
    expect(paths.get('pdf')?.map((c) => c.id)).toEqual(['kindle-epub', 'epub-pdf']);
    expect([...paths.values()].every((path, i, all) => i === 0 || pathFidelity(path) <= pathFidelity(all[i - 1]!))).toBe(true);
    // What each step keeps, kept again: 0.95 of 0.7.
    expect(pathFidelity(paths.get('pdf')!)).toBeCloseTo(0.95 * 0.7);
    expect(pathFidelity([])).toBe(1);
    // Plain text is a step only where nothing else reaches: an EPUB's RTF from its own conversion, not by way of its words.
    expect(conversionPath('epub', 'rtf')?.map((c) => c.id)).toEqual(['epub-rtf']);
    expect(conversionPath('rtf', 'txt')?.map((c) => c.id)).toEqual(['rtf-epub', 'epub-txt']);
    expect(conversionPath('txt', 'rtf')?.map((c) => c.id)).toEqual(['txt-epub', 'epub-rtf']);
    expect(conversionPath('epub', 'cbz')).toBeUndefined();
  });

  it('gives each converter on a path its own options, each asked for once', () => {
    const path = [...conversionPath('pdf', 'epub')!, ...conversionPath('epub', 'pdf')!];
    const keys = pathOptions(path).map((f) => f.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).toContain('pageSize');
    const pageSize = path[1]!.options!.find((f) => f.key === 'pageSize')!;
    const other = pageSize.choices!.find((c) => c.value !== pageSize.default)!.value;
    const configured = pathWithOptions(path, { pageSize: other });
    expect(configured[0]).toBe(path[0]);
    expect(configured[1]!.version).not.toBe(path[1]!.version);
    expect(pathOptions(conversionPath('mobi', 'epub')!)).toEqual([]);
  });
});
