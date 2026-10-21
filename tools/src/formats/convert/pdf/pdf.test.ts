import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { PDFDict, PDFDocument, PDFHexString, PDFName, PDFRef, PDFString } from 'pdf-lib';
import { describe, expect, it } from 'vitest';
import { buildEpub } from '../../epubBuilder';
import type { ConvertContext } from '../bookFromItem';
import { pdfConverter } from '../converters';
import type { FontFiles } from './fonts';
import { DEFAULT_PDF_OPTIONS, pdfOptionsFrom, pdfVersion, roman } from './options';
import { epubToPdf } from './write';

const require = createRequire(join(process.cwd(), 'package.json'));
const read = async (path: string) => new Uint8Array(await readFile(require.resolve(path)));

/** The typefaces from node_modules, as the app fetches its bundled copies. */
async function fontFiles(): Promise<FontFiles> {
  const face = (pkg: string, name: string, weight: string) => read(`@expo-google-fonts/${pkg}/${weight}/${name}_${weight}.ttf`);
  const family = async (pkg: string, name: string) => ({
    regular: await face(pkg, name, '400Regular'),
    bold: await face(pkg, name, '700Bold'),
    italic: await face(pkg, name, '400Regular_Italic'),
    boldItalic: await face(pkg, name, '700Bold_Italic'),
  });
  return { serif: await family('literata', 'Literata'), mono: await family('jetbrains-mono', 'JetBrainsMono') };
}

const PNG = Uint8Array.from(
  atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='),
  (c) => c.charCodeAt(0),
);

const ctx: ConvertContext = {
  item: {
    title: 'The Night Garden',
    creators: [{ name: 'Ann Author', role: 'aut' }, { name: 'Bo Writer', role: 'aut' }],
    identifiers: {},
    tags: ['Fantasy', 'Gardens'],
    metadata: { description: '<p>A <b>quiet</b> book.</p>', language: 'en' },
  },
  cover: { data: new Blob([PNG], { type: 'image/png' }), mediaType: 'image/png' },
};

const long = (word: string) => Array.from({ length: 40 }, (_, i) => `<p>${word} ${i}: ${'the garden grew in the night, '.repeat(8)}</p>`).join('');

async function sample() {
  return buildEpub({
    title: 'Source',
    creators: [{ name: 'Someone', role: 'aut' }],
    chapters: [
      { id: 'c0', title: 'Contents', body: '<h1>Contents</h1><p><a href="c1.xhtml">One</a></p>' },
      { id: 'c1', title: 'The Seed', body: `<h1>The Seed</h1><p>See <a href="c2.xhtml#deep">the deep part</a> or <a href="https://example.com/">a site</a>.</p><p><img src="../images/dot.png" alt="dot"/></p>${long('seed')}` },
      { id: 'c2', title: 'Chapter 2: Roots', body: `<h1>Chapter 2: Roots</h1><p id="deep">Deep inside.</p><table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table><pre>code  -> here // too</pre>` },
    ],
    resources: [{ path: 'images/dot.png', mediaType: 'image/png', data: PNG }],
  });
}

/** The bookmarks' titles, nested as the outline has them. */
function outline(pdf: PDFDocument): unknown[] {
  const lookup = (ref: unknown) => (ref instanceof PDFRef ? pdf.context.lookup(ref) : ref) as PDFDict | undefined;
  const title = (dict: PDFDict) => (dict.get(PDFName.of('Title')) as PDFHexString | PDFString).decodeText();
  const walk = (first: unknown): unknown[] => {
    const out: unknown[] = [];
    for (let item = lookup(first); item; item = lookup(item.get(PDFName.of('Next')))) {
      const kids = item.get(PDFName.of('First'));
      out.push(kids ? [title(item), walk(kids)] : title(item));
    }
    return out;
  };
  const root = lookup(pdf.catalog.get(PDFName.of('Outlines')));
  return root ? walk(root.get(PDFName.of('First'))) : [];
}

describe('PDF options', () => {
  it('reads the dialog’s values, and records those that aren’t the defaults in the version', () => {
    expect(pdfOptionsFrom({})).toEqual(DEFAULT_PDF_OPTIONS);
    const options = pdfOptionsFrom({ pageSize: 'a4', pageNumbers: 'no', chapterNumbers: 'yes', romanNumerals: 'yes', bookHeader: 'nonsense' });
    expect(options).toMatchObject({ pageSize: 'a4', pageNumbers: false, chapterNumbers: true, romanNumerals: true, bookHeader: false });
    expect(pdfVersion(DEFAULT_PDF_OPTIONS)).toBe('1');
    expect(pdfVersion(options)).toBe('1+a4+no-pageNumbers+chapterNumbers+romanNumerals');
    expect(pdfConverter().withOptions!({ romanNumerals: 'yes' }).version).toBe('1+romanNumerals');
    expect(pdfConverter().options!.map((f) => f.key)).toEqual(['pageSize', 'pageNumbers', 'bookHeader', 'chapterHeader', 'chapterNumbers', 'romanNumerals']);
    expect([1, 4, 9, 14, 40, 1994].map(roman)).toEqual(['I', 'IV', 'IX', 'XIV', 'XL', 'MCMXCIV']);
  });
});

describe('epubToPdf', () => {
  it('typesets the book after its cover, with the library’s metadata, bookmarks and links', async () => {
    const options = pdfOptionsFrom({ chapterNumbers: 'yes', romanNumerals: 'yes' });
    const pdf = await PDFDocument.load(await (await epubToPdf(await sample(), ctx, options, await fontFiles())).arrayBuffer(), { updateMetadata: false });
    expect(pdf.getTitle()).toBe('The Night Garden');
    expect(pdf.getAuthor()).toBe('Ann Author & Bo Writer');
    expect(pdf.getSubject()).toBe('A quiet book.');
    expect(pdf.getKeywords()).toBe('Fantasy Gardens');
    const [width, height] = [pdf.getPage(0).getWidth(), pdf.getPage(0).getHeight()];
    expect([Math.round(width), Math.round(height)]).toEqual([420, 595]);
    // The cover, the contents, a chapter of several pages, and the next from a page of its own.
    expect(pdf.getPageCount()).toBeGreaterThanOrEqual(5);
    // The contents and an already-numbered chapter keep their titles; the one between is chapter I.
    expect(outline(pdf)).toEqual(['Contents', 'I. The Seed', 'Chapter 2: Roots']);

    const annotations = pdf.getPages().flatMap((page) => {
      const annots = page.node.Annots();
      return annots ? annots.asArray().map((ref) => pdf.context.lookup(ref) as PDFDict) : [];
    });
    const uri = annotations.find((a) => a.get(PDFName.of('A')));
    expect((pdf.context.lookup(uri!.get(PDFName.of('A'))) as PDFDict ?? uri!.get(PDFName.of('A')) as PDFDict).get(PDFName.of('URI'))?.toString()).toBe('(https://example.com/)');
    // The contents' link and the one to #deep go to pages in the book.
    expect(annotations.filter((a) => a.get(PDFName.of('Dest')))).toHaveLength(2);
  });

  it('takes the page size asked for, and is a PDF without a cover too', async () => {
    const pdf = await PDFDocument.load(await (await epubToPdf(await sample(), { item: ctx.item }, pdfOptionsFrom({ pageSize: 'letter' }), await fontFiles())).arrayBuffer());
    expect([pdf.getPage(0).getWidth(), pdf.getPage(0).getHeight()]).toEqual([612, 792]);
    expect(outline(pdf)).toEqual(['Contents', 'The Seed', 'Chapter 2: Roots']);
  });
});
