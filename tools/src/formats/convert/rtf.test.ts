import { describe, expect, it } from 'vitest';
import { buildEpub } from '../epubBuilder';
import { parseRtf } from '../text';
import { loadRtfjs } from '../text';
import type { ConvertContext } from './bookFromItem';
import { epubToRtf, imageSize, rtfText } from './rtf';

const PNG = Uint8Array.from(
  atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='),
  (c) => c.charCodeAt(0),
);

const ctx: ConvertContext = {
  item: {
    title: 'The Night Garden',
    creators: [{ name: 'Ann Author', role: 'aut' }, { name: 'Bo Writer', role: 'aut' }, { name: 'Ed Itor', role: 'edt' }],
    identifiers: {},
    tags: ['Fantasy', 'Gardens'],
    metadata: { description: '<p>A <b>quiet</b> book.</p>', publisher: 'Moon Press', language: 'fr', published: '2001-02-03' },
  },
};

async function sample() {
  return buildEpub({
    title: 'Source title',
    creators: [{ name: 'Someone Else', role: 'aut' }],
    chapters: [
      {
        id: 'c1',
        title: 'One',
        body: '<h1>Chapter One</h1><p class="lead">It was a <em>dark</em> and <strong>stormy</strong> night — café “naïve” {braces} \\ 日本 😀.</p><p class="c">Centred.</p><ul><li>First</li><li>Second</li></ul><p><img src="../images/dot.png" alt="a dot"/> See <a href="c2.xhtml#deep">the deep part</a> or <a href="https://example.com/">a site</a>.</p>',
        stylesheets: ['styles/book.css'],
      },
      {
        id: 'c2',
        title: 'Two',
        body: '<h1>Chapter Two</h1><p id="deep">Deep inside.</p><table><tr><th>Name</th><th>Value</th></tr><tr><td>A</td><td>1</td></tr></table><p class="hidden">Not shown.</p>',
        stylesheets: ['styles/book.css'],
      },
    ],
    resources: [
      { path: 'images/dot.png', mediaType: 'image/png', data: PNG },
      { path: 'styles/book.css', mediaType: 'text/css', data: 'p.lead { font-style: italic } p.c { text-align: center } .hidden { display: none }' },
    ],
  });
}

describe('epubToRtf', () => {
  it('escapes RTF’s own characters and writes the rest of Unicode as \\u', () => {
    expect(rtfText('a{b}\\c')).toBe('a\\{b\\}\\\\c');
    expect(rtfText('é—日')).toBe('\\u233?\\u8212?\\u26085?');
    // Beyond the BMP, the surrogates, as signed 16-bit numbers.
    expect(rtfText('😀')).toBe('\\u-10179?\\u-8704?');
    expect(imageSize(PNG)).toEqual({ width: 1, height: 1 });
  });

  it('writes the library’s metadata, which reads back', async () => {
    const rtf = await epubToRtf(await sample(), ctx);
    const parsed = await parseRtf(rtf, 'book.rtf');
    expect(parsed).toMatchObject({
      title: 'The Night Garden',
      creators: [{ name: 'Ann Author', role: 'aut' }, { name: 'Bo Writer', role: 'aut' }],
      tags: ['Fantasy', 'Gardens'],
      metadata: { description: 'A quiet book.', publisher: 'Moon Press' },
    });
    expect(await rtf.text()).toContain('\\deflang1036');
  });

  it('writes the chapters with their headings, formatting, lists, tables, images and links', async () => {
    const rtf = await (await epubToRtf(await sample(), ctx)).text();
    expect(rtf).toMatch(/^\{\\rtf1/);
    expect(rtf.trimEnd().endsWith('}')).toBe(true);
    // Braces balance, outside escapes.
    let depth = 0;
    for (const c of rtf.replace(/\\[\\{}]/g, '')) depth += c === '{' ? 1 : c === '}' ? -1 : 0;
    expect(depth).toBe(0);
    expect(rtf).toMatch(/\\s1\\outlinelevel0[^ ]*\n\{[^}]* Chapter One\}/);
    expect(rtf).toMatch(/\\pagebb[^\n]*\n.*bkmkstart|\\pagebb/);
    expect(rtf).toMatch(/\{\\i\\fs24 It was a \}\{\\i\\fs24 dark\}/);
    expect(rtf).toMatch(/\{\\i\\b\\fs24 stormy\}/);
    expect(rtf).toContain('\\qc');
    expect(rtf).toContain('\\u8226?\\tab ');
    expect(rtf).toContain('{\\pict\\pngblip\\picw1\\pich1');
    expect(rtf).toContain('HYPERLINK "https://example.com/"');
    expect(rtf).toMatch(/HYPERLINK \\\\l "(_n\d+)"[\s\S]*bkmkstart \1\}[\s\S]*Deep inside/);
    expect(rtf).toContain('\\cell');
    expect(rtf).toContain('\\row');
    expect(rtf).not.toContain('Not shown');

    // A reader of RTF makes the same text of it.
    const RTFJS = await loadRtfjs();
    const elements = await new RTFJS.Document(new TextEncoder().encode(rtf).buffer, {}).render();
    const text = elements.map((e) => e.textContent).join('\n');
    for (const words of ['Chapter One', 'It was a dark and stormy night — café “naïve” {braces} \\ 日本 😀.', 'Centred.', 'Second', 'Deep inside.', 'Value']) {
      expect(text).toContain(words);
    }
  });
});
