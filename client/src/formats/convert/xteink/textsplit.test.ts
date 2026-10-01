import { describe, expect, it } from 'vitest';
import {
  PARA_LIMIT,
  parseNodes,
  SPLIT_LIMIT,
  splitBigParagraphs,
  splitEpubText,
  splitTextSentences,
  splitXhtmlDoc,
  visibleText,
  type EpubEntries,
} from './textsplit';

const sentence = (n: number) => `Sentence number ${n} is here, and it goes on for a little while. `;
const prose = (bytes: number) => {
  let text = '';
  for (let n = 0; text.length < bytes; n++) text += sentence(n);
  return text.trim();
};
const page = (body: string) =>
  `<?xml version="1.0" encoding="utf-8"?>\n<html xmlns="http://www.w3.org/1999/xhtml"><head><title>T</title></head><body>${body}</body></html>`;

describe('text splitting', () => {
  it('parses balanced top-level nodes, including comments, void tags and processing instructions', () => {
    expect(parseNodes('a<p class="x">b<br>c<i>d</i></p><!-- <p> --><?pi x?><img src="i.jpg"/>e')).toEqual([
      'a',
      '<p class="x">b<br>c<i>d</i></p>',
      '<!-- <p> -->',
      '<?pi x?>',
      '<img src="i.jpg"/>',
      'e',
    ]);
    expect(() => parseNodes('<p>unclosed')).toThrow();
  });

  it('cuts text at sentence ends without losing anything', () => {
    const text = prose(5000);
    const pieces = splitTextSentences(text, 1200);
    expect(pieces.join('')).toBe(text);
    expect(pieces.length).toBeGreaterThan(3);
    for (const piece of pieces.slice(0, -1)) {
      expect(piece.length).toBeLessThanOrEqual(1200);
      expect(piece.endsWith('. ')).toBe(true);
    }
  });

  it('splits long paragraphs into siblings, keeping the id on the first, inline tags whole, and the text', () => {
    const inner = `${prose(1000)} <em>${prose(800)}</em> ${prose(900)}`;
    const html = `<div><p id="p1" class="c">${inner}</p><p>short</p></div>`;
    const { html: out, changed } = splitBigParagraphs(html);
    expect(changed).toBe(true);
    const paragraphs = out.match(/<p\b[^>]*>[\s\S]*?<\/p>/g)!;
    expect(paragraphs.length).toBeGreaterThan(2);
    expect(paragraphs[0]).toMatch(/^<p id="p1" class="c">/);
    expect(paragraphs[1]).toMatch(/^<p class="c">/);
    expect(out.match(/<em>/g)).toHaveLength(1);
    expect(visibleText(out)).toBe(visibleText(html));
  });

  it('leaves paragraphs with block content alone', () => {
    const html = `<p>${prose(PARA_LIMIT + 100)}<div>block</div></p>`;
    expect(splitBigParagraphs(html)).toEqual({ html, changed: false });
  });

  it('splits big documents into named chunks that keep the head', () => {
    const body = Array.from({ length: 40 }, (_, i) => `<p id="n${i}">${prose(400)}</p>`).join('\n');
    const pieces = splitXhtmlDoc(page(body), 'ch1.xhtml');
    expect(pieces.length).toBeGreaterThan(1);
    expect(pieces.map(([name]) => name).slice(0, 3)).toEqual(['ch1.xhtml', 'ch1_ek1.xhtml', 'ch1_ek2.xhtml']);
    for (const [, content] of pieces) {
      expect(content).toContain('<head><title>T</title></head>');
      expect(content.length).toBeLessThan(SPLIT_LIMIT + 300);
    }
    expect(pieces.map(([, c]) => visibleText(c)).join(' ')).toBe(visibleText(page(body)));
    expect(splitXhtmlDoc(page('<p>small</p>'), 'ch2.xhtml')).toEqual([]);
  });

  it('rewrites an EPUB: manifest, spine, fragment links, fonts, page lists and data images', async () => {
    const body = Array.from({ length: 40 }, (_, i) => `<p id="n${i}">${prose(400)}</p>`).join('\n');
    const entries: EpubEntries = {
      opfPath: 'OEBPS/content.opf',
      order: ['OEBPS/content.opf', 'OEBPS/text/ch1.xhtml', 'OEBPS/text/notes.xhtml', 'OEBPS/style.css', 'OEBPS/f.ttf'],
      data: new Map<string, string | Uint8Array>([
        [
          'OEBPS/content.opf',
          `<package><manifest>
            <item id="ch1" href="text/ch1.xhtml" media-type="application/xhtml+xml"/>
            <item id="notes" href="text/notes.xhtml" media-type="application/xhtml+xml"/>
            <item id="font" href="f.ttf" media-type="font/ttf"/>
          </manifest><spine><itemref idref="ch1"/><itemref idref="notes"/></spine></package>`,
        ],
        ['OEBPS/text/ch1.xhtml', page(body)],
        [
          'OEBPS/text/notes.xhtml',
          page(
            '<nav epub:type="page-list"><ol><li>1</li></ol></nav><p><a href="ch1.xhtml#n39">last</a> <img src="data:image/png;base64,iVBORw0KGgo="/></p>',
          ),
        ],
        ['OEBPS/style.css', '@font-face { font-family: X; src: url(f.ttf); }\np { margin: 0 }'],
        ['OEBPS/f.ttf', new Uint8Array([1, 2, 3])],
      ]),
    };
    const summary = await splitEpubText(entries, async () => new Uint8Array([0xff, 0xd8]));
    expect(summary).toMatchObject({ fileSplits: 1, fonts: 1, dataImages: 1 });

    const opf = entries.data.get('OEBPS/content.opf') as string;
    const chunks = entries.order.filter((p) => p.startsWith('OEBPS/text/ch1'));
    expect(chunks.length).toBeGreaterThan(1);
    expect(entries.order.indexOf('OEBPS/text/ch1_ek1.xhtml')).toBe(entries.order.indexOf('OEBPS/text/ch1.xhtml') + 1);
    expect(opf).toContain('<item id="ch1_ek1" href="text/ch1_ek1.xhtml" media-type="application/xhtml+xml"/>');
    expect(opf).toMatch(/<itemref idref="ch1"\/>\s*<itemref idref="ch1_ek1"\/>/);
    expect(opf).toContain('<item id="dataimg_0" href="text/dataimg_0.jpg" media-type="image/jpeg"/>');
    expect(opf).not.toContain('f.ttf');

    const notes = entries.data.get('OEBPS/text/notes.xhtml') as string;
    const last = chunks.at(-1)!.split('/').pop();
    expect(notes).toContain(`href="${last}#n39"`);
    expect(notes).toContain('src="dataimg_0.jpg"');
    expect(notes).not.toContain('page-list');
    expect(entries.data.get('OEBPS/text/dataimg_0.jpg')).toEqual(new Uint8Array([0xff, 0xd8]));
    expect(entries.data.has('OEBPS/f.ttf')).toBe(false);
    expect(entries.data.get('OEBPS/style.css')).toBe('p { margin: 0 }');
  });
});
