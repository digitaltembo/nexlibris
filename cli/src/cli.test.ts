import './environment';
import './plugins';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initKf8File, initMobiFile } from '@lingo-reader/mobi-parser';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { coverColor } from '@nexlibris/tools/coverColor';
import { buildEpub } from '@nexlibris/tools/formats/epubBuilder';
import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import { parseCommand, UsageError } from './args';
import { applyEdits, bookInfo, conversionMatrix, conversionPath, convertBook, formatInfo, formatList, readBook, setMetadata, writeConversion, writeCover } from './commands';

const fixture = (name: string) => join(process.cwd(), '../tools/src/formats/fixtures', name);
const folder = () => mkdtemp(join(tmpdir(), 'nexlibris-cli-'));

/** A PNG of one colour. */
function png(width: number, height: number, colour: string): Uint8Array<ArrayBuffer> {
  const canvas = createCanvas(width, height);
  const context = canvas.getContext('2d');
  context.fillStyle = colour;
  context.fillRect(0, 0, width, height);
  return new Uint8Array(canvas.toBuffer('image/png'));
}

/** A one-page PDF with a title and author, written by hand. */
function minimalPdf(): Uint8Array<ArrayBuffer> {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] >>',
    '<< /Title (A Small PDF) /Author (Pat Writer) >>',
  ];
  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((object, i) => {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info 4 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(pdf);
}

async function epubFile(dir: string) {
  const path = join(dir, 'Dune.epub');
  const epub = await buildEpub({
    title: 'Dune',
    creators: [{ name: 'Frank Herbert', role: 'aut' }],
    tags: ['Science Fiction', 'Classic'],
    chapters: [{ id: 'c1', title: 'One', body: '<p>A beginning is the time.</p>' }],
  });
  await writeFile(path, new Uint8Array(await epub.arrayBuffer()));
  return path;
}

describe('parseCommand', () => {
  it('reads each command and its options', () => {
    expect(parseCommand(['info', 'a.epub', '--json'])).toEqual({ command: 'info', book: 'a.epub', json: true });
    expect(parseCommand(['convert', 'a.mobi', '--to', 'epub', '-o', 'b.epub', '--option', 'quality=70'])).toEqual({
      command: 'convert',
      book: 'a.mobi',
      to: 'epub',
      output: 'b.epub',
      options: { quality: '70' },
    });
    expect(parseCommand(['set', 'a.epub', '--author', 'A', '--author', 'B', '--add-tag', 'x'])).toMatchObject({
      edits: { authors: ['A', 'B'], addTags: ['x'], removeTags: [] },
    });
    expect(parseCommand([])).toEqual({ command: 'help' });
    expect(parseCommand(['info', 'a.epub', '-h'])).toEqual({ command: 'help' });
    expect(parseCommand(['convert', '--help'])).toEqual({ command: 'help', topic: 'convert' });
    expect(parseCommand(['help', 'convert'])).toEqual({ command: 'help', topic: 'convert' });
  });

  it('refuses what it can’t make sense of', () => {
    expect(() => parseCommand(['info'])).toThrow(UsageError);
    expect(() => parseCommand(['info', 'a.epub', 'b.epub'])).toThrow('One book at a time');
    expect(() => parseCommand(['info', 'a.epub', '--nope'])).toThrow(UsageError);
    expect(() => parseCommand(['convert', 'a.epub'])).toThrow('--to');
    expect(() => parseCommand(['convert', 'a.epub', '--to', 'txt', '--option', 'quality'])).toThrow('<key>=<value>');
    expect(() => parseCommand(['set', 'a.epub'])).toThrow('Nothing to change');
    expect(() => parseCommand(['frobnicate'])).toThrow('no command');
  });
});

describe('info and cover', () => {
  it('reads a book’s metadata and writes its cover', async () => {
    const book = await readBook(fixture('sample.azw3'));
    const info = await bookInfo(book);
    expect(info).toMatchObject({ title: 'The Kindle Sample', creators: [{ name: 'Mo Bee', role: 'aut' }], cover: { mediaType: 'image/png' } });
    expect(formatInfo(info)).toContain('Author:    Mo Bee\n');

    const out = join(await folder(), 'cover.png');
    await writeCover(await readBook(fixture('sample.cbz')), out);
    expect([...(await readFile(out)).subarray(1, 4)]).toEqual([...Buffer.from('PNG')]);
  });

  it('says which files it can’t read', async () => {
    await expect(readBook('notes.doc')).rejects.toThrow('not a format the tools read');
    await expect(readBook(join(await folder(), 'missing.epub'))).rejects.toThrow('Can’t read');
  });
});

describe('convert', () => {
  it('finds conversions through others', () => {
    expect(conversionPath('mobi', 'x4.epub')?.map((c) => c.id)).toEqual(['kindle-epub', 'xteink-x4']);
    expect(conversionPath('cbr', 'txt')?.map((c) => c.id)).toEqual(['comic-epub', 'epub-txt']);
    expect(conversionPath('pdf', 'epub')?.map((c) => c.id)).toEqual(['pdf-epub']);
    expect(conversionPath('pdf', 'azw3')?.map((c) => c.id)).toEqual(['pdf-epub', 'epub-azw3']);
    expect(conversionPath('cbz', 'cbr')?.map((c) => c.id)).toEqual(['cbz-cbr']);
    expect(conversionPath('rtf', 'azw3')?.map((c) => c.id)).toEqual(['rtf-epub', 'epub-azw3']);
    // Through plain text an X4 EPUB would come back as EPUB with only its words; by way of AZW3 it loses far less.
    expect(conversionPath('x4.epub', 'epub')?.map((c) => c.id)).toEqual(['epub-azw3', 'kindle-epub']);
    expect(conversionPath('x4.epub', 'mobi')?.map((c) => c.id)).toEqual(['epub-mobi']);
  });

  it('tabulates which formats convert to which', () => {
    const rows = Object.fromEntries(conversionMatrix().split('\n').filter(Boolean).slice(1).map((line) => [line.split(/\s+/)[0], line.split(/\s+/).slice(1)]));
    expect(rows['from']).toEqual(['\\', 'to', 'epub', 'pdf', 'cbz', 'cbr', 'txt', 'rtf', 'mobi', 'azw3', 'azw', 'x4.epub', 'x3.epub']);
    expect(rows['epub']).toEqual(['—', '●', '●', '●', '●', '●', '●', '●', '●']);
    expect(rows['cbz']).toEqual(['●', '○', '—', '●', '○', '○', '○', '○', '○', '○', '○']);
    expect(rows['x4.epub']).toEqual(['○', '●', '●', '●', '●', '●', '●', '—', '○']);
  });

  it.each(['azw3', 'mobi'] as const)('converts an EPUB to %s, with its images, that a Kindle reader reads', async (to) => {
    const dir = await folder();
    const path = join(dir, 'Pictures.epub');
    const epub = await buildEpub({
      title: 'Pictures',
      creators: [{ name: 'Ann Artist', role: 'aut' }],
      chapters: [
        { id: 'c1', title: 'One', body: '<p>A <em>red</em> square:</p><p><img src="../images/red.webp" alt="red"/></p><p><a href="c2.xhtml#end">To the end</a></p>' },
        { id: 'c2', title: 'Two', body: '<p id="end">The end.</p>' },
      ],
      resources: [{ path: 'images/red.webp', mediaType: 'image/webp', data: new Uint8Array(createCanvas(40, 40).toBuffer('image/webp')) }],
      cover: { data: new Blob([png(300, 450, '#336699')], { type: 'image/png' }), mediaType: 'image/png' },
    });
    await writeFile(path, new Uint8Array(await epub.arrayBuffer()));
    const out = await writeConversion(await readBook(path), to, {}, join(dir, `Pictures.${to}`));
    expect(await bookInfo(await readBook(out))).toMatchObject({ format: to, title: 'Pictures', creators: [{ name: 'Ann Artist', role: 'aut' }], cover: { mediaType: 'image/png' } });

    const bytes = new Uint8Array(await readFile(out));
    const book = to === 'azw3' ? await initKf8File(bytes, dir) : await initMobiFile(bytes, dir);
    try {
      const html = book.getSpine().map((c) => book.loadChapter(c.id)?.html ?? '').join('');
      expect(html).toContain('The end.');
      expect(html).toMatch(to === 'azw3' ? /<em[^>]*>red<\/em>/ : /<i>red<\/i>/);
    } finally {
      book.destroy();
    }
    // The cover, its thumbnail (a JPEG), and the WebP image redrawn as a PNG, which Kindles show.
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const kinds = Array.from({ length: view.getUint16(76) }, (_, i) => {
      const at = view.getUint32(78 + i * 8);
      return String.fromCharCode(...bytes.subarray(at, at + 4));
    });
    expect(kinds.filter((k) => k === '\x89PNG')).toHaveLength(2);
    expect(kinds.filter((k) => k.startsWith('\xff\xd8\xff'))).toHaveLength(1);
    expect(kinds).not.toContain('RIFF');
  });

  it('converts a Kindle book to EPUB, with its metadata, keeping the parser’s files out of the current folder', async () => {
    const out = join(await folder(), 'sample.epub');
    await writeConversion(await readBook(fixture('sample.azw3')), 'epub', {}, out);
    expect(await bookInfo(await readBook(out))).toMatchObject({ format: 'epub', title: 'The Kindle Sample', cover: {} });
    expect(existsSync(join(process.cwd(), 'images'))).toBe(false);
  });

  it('converts text to EPUB and back', async () => {
    const dir = await folder();
    await writeFile(join(dir, 'The Night.txt'), 'Chapter One\n\nIt was a dark night.\n');
    const epub = join(dir, 'The Night.epub');
    await writeConversion(await readBook(join(dir, 'The Night.txt')), 'epub', {}, epub);
    expect((await bookInfo(await readBook(epub))).title).toBe('The Night');
    const { data } = await convertBook(await readBook(epub), 'txt', {});
    expect(await data.text()).toContain('It was a dark night.');
  });

  it('checks options against the conversions’ own, and won’t overwrite the book', async () => {
    const book = await readBook(await epubFile(await folder()));
    await expect(convertBook(book, 'txt', { quality: '70' })).rejects.toThrow('No conversion here takes quality');
    await expect(convertBook(book, 'epub', {})).rejects.toThrow('EPUB already');
    await expect(convertBook(book, 'cbz', {})).rejects.toThrow('no way to convert');
    await expect(convertBook(book, 'pdf', { chapterNumbers: 'maybe' })).rejects.toThrow('yes or no');
    await expect(convertBook(book, 'docx', {})).rejects.toThrow('no format docx');
    await expect(writeConversion(book, 'txt', {}, book.path)).rejects.toThrow('overwrite the book itself');
  });

  it('optimizes for a CrossPoint reader, re-encoding images as grayscale JPEGs on Node’s canvas', async () => {
    const dir = await folder();
    const path = join(dir, 'Pictures.epub');
    const epub = await buildEpub({
      title: 'Pictures',
      creators: [{ name: 'Ann Artist', role: 'aut' }],
      chapters: [{ id: 'c1', title: 'One', body: '<p>A red square:</p><p><img src="../images/red.png" alt="red"/></p>' }],
      resources: [{ path: 'images/red.png', mediaType: 'image/png', data: png(1200, 1600, '#ff0000') }],
    });
    await writeFile(path, new Uint8Array(await epub.arrayBuffer()));
    const out = await writeConversion(await readBook(path), 'x4.epub', { quality: '70' }, join(dir, 'Pictures.x4.epub'));
    const zip = await JSZip.loadAsync(await readFile(out));
    const image = await zip.file('OEBPS/images/red.jpg')?.async('uint8array');
    expect([...image!.subarray(0, 3)]).toEqual([0xff, 0xd8, 0xff]);
    const decoded = await loadImage(Buffer.from(image!));
    expect(decoded.width).toBeLessThanOrEqual(480);
    const context = createCanvas(decoded.width, decoded.height).getContext('2d');
    context.drawImage(decoded, 0, 0);
    const [r, g, b] = context.getImageData(1, 1, 1, 1).data;
    expect(r).toBe(g);
    expect(g).toBe(b);
  });

  it('typesets an EPUB as a PDF, with the options asked for', async () => {
    const dir = await folder();
    const path = join(dir, 'Garden.epub');
    const paragraphs = Array.from({ length: 30 }, (_, i) => `<p>Line ${i} of the garden, ${'which grew in the night '.repeat(6)}</p>`).join('');
    const epub = await buildEpub({
      title: 'Garden',
      creators: [{ name: 'Ann Author', role: 'aut' }],
      tags: ['Fantasy'],
      chapters: [{ id: 'c1', title: 'The Seed', body: `<h1>The Seed</h1>${paragraphs}` }],
      cover: { data: new Blob([png(300, 450, '#336699')], { type: 'image/png' }), mediaType: 'image/png' },
    });
    await writeFile(path, new Uint8Array(await epub.arrayBuffer()));
    const out = await writeConversion(await readBook(path), 'pdf', { chapterNumbers: 'yes', romanNumerals: 'yes', bookHeader: 'yes' }, join(dir, 'Garden.pdf'));
    expect(await bookInfo(await readBook(out))).toMatchObject({ format: 'pdf', title: 'Garden', creators: [{ name: 'Ann Author', role: 'aut' }], tags: ['Fantasy'], cover: {} });

    const { getDocument } = await import('pdfjs-dist');
    const task = getDocument({ data: new Uint8Array(await readFile(out)) });
    const doc = await task.promise;
    const pages: string[] = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const content = await (await doc.getPage(i)).getTextContent();
      pages.push(content.items.map((item) => ('str' in item ? item.str : '')).join(' ').replace(/\s+/g, ' '));
    }
    await task.destroy();
    expect(pages.length).toBeGreaterThanOrEqual(3);
    // The cover has no text; the chapter opens with its number and no header; later pages have both headers and numbers.
    expect(pages[0]).toBe('');
    expect(pages[1]).toMatch(/^Chapter I The Seed Line 0 of the garden/);
    expect(pages[1]).not.toContain('I. The Seed');
    expect(pages[1]).toMatch(/ 2$/);
    // The headers and the number are drawn after the page's text.
    expect(pages[2]).toMatch(/^Line \d+ of the garden.* Garden I\. The Seed 3$/);
    expect(pages.join(' ')).toContain('Line 29 of the garden');
  });

  it('reflows a PDF’s text as an EPUB, without its headers and page numbers', async () => {
    const dir = await folder();
    const chapter = (n: number, title: string) => ({
      id: `c${n}`,
      title,
      body: `<h1>${title}</h1>${Array.from({ length: 12 }, (_, i) => `<p>Paragraph ${n}.${i} of a well-known garden, ${'which grew in the night and '.repeat(5 + (i % 4))}slept.</p>`).join('')}`,
    });
    const epub = await buildEpub({ title: 'Garden', creators: [{ name: 'Ann Author', role: 'aut' }], chapters: [chapter(1, 'The Seed'), chapter(2, 'Roots'), chapter(3, 'The Long Winter')] });
    await writeFile(join(dir, 'Garden.epub'), new Uint8Array(await epub.arrayBuffer()));
    const pdf = await writeConversion(await readBook(join(dir, 'Garden.epub')), 'pdf', { bookHeader: 'yes', chapterNumbers: 'yes' }, join(dir, 'Garden.pdf'));

    const read = async (options: Record<string, string>) => {
      const out = await writeConversion(await readBook(pdf), 'epub', options, join(dir, 'Back.epub'));
      const zip = await JSZip.loadAsync(await readFile(out));
      const files = Object.keys(zip.files).filter((name) => /text\/c\d+\.xhtml$/.test(name)).sort();
      const pages = await Promise.all(files.map((name) => zip.file(name)!.async('string')));
      return pages.map((page) => ({
        title: /<h1>([^<]*)<\/h1>/.exec(page)![1],
        paragraphs: [...page.matchAll(/<p>([^<]*)<\/p>/g)].map((m) => m[1]),
      }));
    };
    // Chapters from the PDF's bookmarks, the paragraphs as they were, across pages too, with no header or page number among them.
    const chapters = await read({});
    expect(chapters.map((c) => c.title)).toEqual(['Garden Ann Author', 'Contents', '1. The Seed', '2. Roots', '3. The Long Winter'].slice(-3));
    for (const [n, c] of chapters.entries()) {
      expect(c.paragraphs).toEqual(Array.from({ length: 12 }, (_, i) => `Paragraph ${n + 1}.${i} of a well-known garden, ${'which grew in the night and '.repeat(5 + (i % 4))}slept.`));
    }
    // From the printed headings, "Chapter 2" over "Roots".
    expect((await read({ chapters: 'headings' })).map((c) => c.title)).toEqual(['Chapter 1: The Seed', 'Chapter 2: Roots', 'Chapter 3: The Long Winter']);
    // Text in the margins asked to be ignored is left out.
    const cut = await read({ chapters: 'none', rightLeft: '30', leftLeft: '30' });
    expect(cut).toHaveLength(1);
    expect(cut[0]!.paragraphs.join(' ')).not.toContain('Paragraph');
    // A PDF of images alone needs OCR first.
    await writeFile(join(dir, 'scan.pdf'), minimalPdf());
    await expect(convertBook(await readBook(join(dir, 'scan.pdf')), 'epub', {})).rejects.toThrow('no text layer');
  });

  it('finds a cover’s colour, and draws a PDF’s first page as its cover', async () => {
    expect(await coverColor(new Blob([png(60, 90, '#336699')]))).toBe('#336699');
    const dir = await folder();
    await writeFile(join(dir, 'small.pdf'), minimalPdf());
    expect(await bookInfo(await readBook(join(dir, 'small.pdf')))).toMatchObject({ title: 'A Small PDF', cover: { mediaType: 'image/jpeg' } });
  });
});

describe('set', () => {
  it('changes an EPUB’s metadata in place', async () => {
    const path = await epubFile(await folder());
    const info = await setMetadata(await readBook(path), {
      title: 'The Dune',
      authors: ['Ursula K. Le Guin'],
      addTags: ['Favourite'],
      removeTags: ['classic'],
      series: 'Dune',
      seriesIndex: '1',
      published: 'August 1965',
    });
    expect(info).toMatchObject({
      title: 'The Dune',
      creators: [{ name: 'Ursula K. Le Guin', role: 'aut' }],
      tags: ['Science Fiction', 'Favourite'],
      metadata: { series: 'Dune', seriesIndex: 1, published: '1965-08' },
    });
    expect(await bookInfo(await readBook(path))).toMatchObject({ title: 'The Dune', tags: ['Science Fiction', 'Favourite'] });
  });

  it('gives a new title and authors new sorts where the book had sorts, unless they’re given', () => {
    const parsed = { title: 'Dune', creators: [{ name: 'Frank Herbert', role: 'aut' }, { name: 'Ed Itor', role: 'edt' }], identifiers: {}, tags: [] };
    const sorted = { ...parsed, metadata: { titleSort: 'Dune', authorSort: 'Herbert, Frank' } };
    expect(applyEdits(sorted, { title: 'The Dune', authors: ['Ursula K. Le Guin'], addTags: [], removeTags: [] })).toMatchObject({
      creators: [{ name: 'Ursula K. Le Guin', role: 'aut' }, { name: 'Ed Itor', role: 'edt' }],
      metadata: { titleSort: 'Dune, The', authorSort: 'Le Guin, Ursula K.' },
    });
    expect(applyEdits(sorted, { title: 'The Dune', titleSort: 'Dune (1965)', addTags: [], removeTags: [] }).metadata.titleSort).toBe('Dune (1965)');
    expect(applyEdits({ ...parsed, metadata: {} }, { title: 'The Dune', addTags: [], removeTags: [] }).metadata).toEqual({});
    expect(() => applyEdits(sorted, { seriesIndex: 'two', addTags: [], removeTags: [] })).toThrow('a number');
  });

  it('changes a Kindle book’s metadata, refusing what it has no place for', async () => {
    const dir = await folder();
    const path = join(dir, 'joint.mobi');
    await writeFile(path, await readFile(fixture('sample-joint.mobi')));
    const info = await setMetadata(await readBook(path), { title: 'Renamed', authors: ['Ann Writer'], addTags: ['Added'], removeTags: [], publisher: 'Elsewhere' });
    expect(info).toMatchObject({ title: 'Renamed', creators: [{ name: 'Ann Writer', role: 'aut' }], tags: ['Testing', 'Added'], metadata: { publisher: 'Elsewhere' } });
    expect(info.identifiers.isbn).toBe('9780000000002');
    expect((await bookInfo(await readBook(path))).title).toBe('Renamed');
    await expect(setMetadata(await readBook(path), { series: 'Dune', titleSort: 'X', addTags: [], removeTags: [] })).rejects.toThrow(
      'no place for --series or --title-sort',
    );
  });

  it('writes elsewhere when told to, and only EPUBs and Kindle books', async () => {
    const dir = await folder();
    const path = await epubFile(dir);
    const copy = join(dir, 'copy.epub');
    await setMetadata(await readBook(path), { tags: ['Desert'], addTags: [], removeTags: [] }, copy);
    expect((await bookInfo(await readBook(copy))).tags).toEqual(['Desert']);
    expect((await bookInfo(await readBook(path))).tags).toEqual(['Science Fiction', 'Classic']);
    await expect(setMetadata(await readBook(fixture('sample.cbz')), { title: 'X', addTags: [], removeTags: [] })).rejects.toThrow('Only EPUBs’ and Kindle books’');
  });
});

describe('formats', () => {
  it('lists plugins’ formats and the conversions’ options', () => {
    const list = formatList();
    expect(list).toContain('x4.epub  EPUB (X4)');
    expect(list).toContain('--option quality=<1–100>');
  });
});
