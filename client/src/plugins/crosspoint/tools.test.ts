import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import { fakeReader } from './fakeReader';
import { isCpfont, sortFonts } from './fonts';
import { encodeBmp, placement, sleepImageName, toGray } from './sleepImage';
import { parseIfo, prepareDictionaries, untar } from './stardict';

const blob = (text: string) => new Blob([text]);

describe('sleep images', () => {
  it('encodes BMPs bottom-up, BGR, with rows padded to 4 bytes', async () => {
    // 2×2: red, green / blue, white.
    const rgba = new Uint8ClampedArray([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255]);
    const bytes = new Uint8Array(await encodeBmp(rgba, 2, 2).arrayBuffer());
    const view = new DataView(bytes.buffer);
    expect(String.fromCharCode(bytes[0]!, bytes[1]!)).toBe('BM');
    expect(view.getUint32(2, true)).toBe(54 + 8 * 2);
    expect([view.getInt32(18, true), view.getInt32(22, true), view.getUint16(28, true)]).toEqual([2, 2, 24]);
    // The first row stored is the bottom one: blue, white, then 2 bytes of padding.
    expect([...bytes.slice(54, 62)]).toEqual([255, 0, 0, 255, 255, 255, 0, 0]);
    expect([...bytes.slice(62, 68)]).toEqual([0, 0, 255, 0, 255, 0]);
  });

  it('makes pixels gray, transparent ones as on white', () => {
    const rgba = new Uint8ClampedArray([255, 0, 0, 255, 0, 0, 0, 0]);
    toGray(rgba);
    expect([...rgba]).toEqual([54, 54, 54, 255, 255, 255, 255, 255]);
  });

  it('fills the screen by cropping, or fits the picture whole', () => {
    const screen = { width: 480, height: 800 };
    expect(placement({ width: 1000, height: 1000 }, screen, 'fill')).toEqual({ x: -160, y: 0, width: 800, height: 800 });
    expect(placement({ width: 1000, height: 1000 }, screen, 'fit')).toEqual({ x: 0, y: 160, width: 480, height: 480 });
  });

  it('names images after their pictures, without clashing', () => {
    expect(sleepImageName('Cat photo!.jpg', new Set())).toBe('Cat photo.bmp');
    expect(sleepImageName('cat photo.png', new Set(['cat photo.bmp']))).toBe('cat photo 2.bmp');
  });
});

/** A tar archive of files, as `tar` writes them. */
function tar(files: Record<string, string>): Uint8Array<ArrayBuffer> {
  const blocks: Uint8Array[] = [];
  for (const [name, content] of Object.entries(files)) {
    const header = new Uint8Array(512);
    header.set(new TextEncoder().encode(name), 0);
    header.set(new TextEncoder().encode(content.length.toString(8).padStart(11, '0')), 124);
    header[156] = '0'.charCodeAt(0);
    const body = new Uint8Array(Math.ceil(content.length / 512) * 512);
    body.set(new TextEncoder().encode(content));
    blocks.push(header, body);
  }
  blocks.push(new Uint8Array(1024));
  const out = new Uint8Array(blocks.reduce((n, b) => n + b.length, 0));
  let at = 0;
  for (const b of blocks) {
    out.set(b, at);
    at += b.length;
  }
  return out;
}

async function gzip(bytes: Uint8Array<ArrayBuffer>): Promise<Blob> {
  return new Response(new Blob([bytes]).stream().pipeThrough(new CompressionStream('gzip'))).blob();
}

describe('dictionaries', () => {
  it('reads .ifo fields', () => {
    expect(parseIfo('StarDict\'s dict ifo file\nversion=2.4.2\nbookname=Webster 1913\nwordcount=10\n')).toMatchObject({ bookname: 'Webster 1913', wordcount: '10' });
  });

  it('sorts loose files and folders into dictionaries, decompressing a gzipped index', async () => {
    const { dictionaries, problems } = await prepareDictionaries([
      { path: 'webster/webster.idx.gz', data: await gzip(new TextEncoder().encode('index')) },
      { path: 'webster/webster.dict.dz', data: blob('definitions') },
      { path: 'webster/webster.ifo', data: blob('bookname=Webster 1913\nwordcount=1200') },
      { path: 'fr-en.idx', data: blob('i') },
      { path: 'fr-en.dict', data: blob('d') },
      { path: 'fr-en.syn', data: blob('s') },
      { path: 'lonely.idx', data: blob('i') },
      { path: 'huge.idx', data: blob('i') },
      { path: 'huge.dict', data: blob('d') },
      { path: 'huge.ifo', data: blob('idxoffsetbits=64') },
    ]);
    expect(dictionaries.map((d) => [d.name, d.title, d.words, d.files.map((f) => f.name)])).toEqual([
      ['webster', 'Webster 1913', 1200, ['webster.idx', 'webster.dict.dz', 'webster.ifo']],
      ['fr-en', undefined, undefined, ['fr-en.idx', 'fr-en.dict', 'fr-en.syn']],
    ]);
    expect(await dictionaries[0]!.files[0]!.data.text()).toBe('index');
    expect(problems).toEqual(['lonely: a dictionary needs its .dict or .dict.dz file too.', 'huge: uses 64-bit offsets, which CrossPoint can’t read.']);
  });

  it('unpacks zip, tar and tar.gz archives', async () => {
    const zip = new JSZip();
    zip.file('dict-en-en/en.idx', 'i');
    zip.file('dict-en-en/en.dict.dz', 'd');
    const files = { 'oxford/ox.idx': 'i', 'oxford/ox.dict': 'd' };
    expect(untar(tar(files)).map((f) => f.path)).toEqual(['oxford/ox.idx', 'oxford/ox.dict']);
    const { dictionaries, problems } = await prepareDictionaries([
      { path: 'en.zip', data: await zip.generateAsync({ type: 'blob' }) },
      { path: 'oxford.tar.gz', data: await gzip(tar(files)) },
      { path: 'other.tar.bz2', data: blob('') },
    ]);
    expect(dictionaries.map((d) => d.name)).toEqual(['dict-en-en', 'oxford']);
    expect(problems).toEqual(['other.tar.bz2: unpack this on your computer first; nexlibris reads zip, tar and tar.gz.']);
  });
});

describe('fonts', () => {
  it('sorts .cpfont sizes and TTF styles into families', () => {
    const { uploads, skipped } = sortFonts([
      { path: 'Literata_12.cpfont', data: blob('') },
      { path: 'Literata_14.cpfont', data: blob('') },
      { path: 'Bookerly-Bold.ttf', data: blob('') },
      { path: 'Atkinson Hyperlegible/Regular.otf', data: blob('') },
      { path: 'README.md', data: blob('') },
    ]);
    expect(uploads.map((u) => [u.family, u.kind, u.name])).toEqual([
      ['Literata', 'cpfont', 'Literata_12.cpfont'],
      ['Literata', 'cpfont', 'Literata_14.cpfont'],
      ['Bookerly', 'direct', 'Bookerly-Bold.ttf'],
      ['Atkinson_Hyperlegible', 'direct', 'Regular.otf'],
    ]);
    expect(skipped).toEqual(['README.md']);
  });

  it('checks .cpfont magic', async () => {
    expect(await isCpfont(new Blob(['CPFONT\0\0rest']))).toBe(true);
    expect(await isCpfont(new Blob(['PK\x03\x04']))).toBe(false);
  });
});

describe('the reader’s web API for these', () => {
  it('makes hidden folders, which listings don’t show, without failing when they exist', async () => {
    const { reader, folders } = fakeReader();
    await reader.makeFolder('/', '.sleep');
    await reader.makeFolder('/', '.sleep');
    expect(folders.has('/.sleep')).toBe(true);
    expect(await reader.entries('/')).toEqual([]);
    await reader.upload('/.sleep/a.bmp', blob('BM'));
    expect((await reader.entries('/.sleep')).map((e) => e.name)).toEqual(['a.bmp']);
  });

  it('moves files into another folder and renames them', async () => {
    const { reader, files } = fakeReader({ files: { '/Books/Dune.epub': blob('dune'), '/Books/Emma.epub': blob('emma') } });
    await reader.ensureFolder('/library/Herbert, Frank');
    await reader.move('/Books/Dune.epub', '/library/Herbert, Frank/Dune - Frank Herbert.epub');
    await reader.move('/Books/Emma.epub', '/Books/Emma - Jane Austen.epub');
    expect([...files.keys()].sort()).toEqual(['/Books/Emma - Jane Austen.epub', '/library/Herbert, Frank/Dune - Frank Herbert.epub']);
  });

  it('adds fonts to families, lists them, and removes them', async () => {
    const { reader } = fakeReader();
    await reader.uploadFont('Literata', 'Literata_12.cpfont', blob('CPFONT\0\0glyphs'));
    await reader.uploadFont('Literata', 'Literata_14.cpfont', blob('CPFONT\0\0glyphs'));
    await expect(reader.uploadFont('Literata', 'x.cpfont', blob('nope'))).rejects.toThrow('Invalid .cpfont file');
    expect(await reader.fonts()).toMatchObject([{ name: 'Literata', sizes: [12, 14] }]);
    expect((await reader.settings()).find((s) => s.key === 'fontFamily')?.options).toContain('Literata');
    await reader.changeSettings({ fontFamily: 2 });
    expect((await reader.settings()).find((s) => s.key === 'fontFamily')?.value).toBe(2);
    await reader.deleteFont('Literata');
    expect(await reader.fonts()).toEqual([]);
  });
});
