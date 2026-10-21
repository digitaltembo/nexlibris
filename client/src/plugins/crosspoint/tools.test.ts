import { describe, expect, it } from 'vitest';
import { fakeReader } from './fakeReader';

const blob = (text: string) => new Blob([text]);

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
