import { createItem } from '@nexlibris/common';
import { describe, expect, it } from 'vitest';
import { DEFAULT_FILE_NAME, expandFolder, expandPath, templateProblems, templateRoot } from './pathTemplate';

const dune = createItem({
  title: 'Dune',
  creators: [{ name: 'Frank Herbert', role: 'aut' }],
  metadata: { series: 'Dune', seriesIndex: 1, originallyPublished: '1965-08-01' },
});
const odd = createItem({
  title: '.What? A "Title": Part 1/2...',
  creators: [{ name: 'AC/DC', role: 'aut' }, { name: 'Someone Else', role: 'aut' }],
});
const anonymous = createItem({ title: 'Beowulf' });

describe('path templates', () => {
  it('puts each book in the folders the template names', () => {
    expect(expandPath('/library/<author>/<title>/', DEFAULT_FILE_NAME, dune, 'epub')).toBe('/library/Frank Herbert/Dune/Dune - Frank Herbert.epub');
    expect(expandPath('/Books', DEFAULT_FILE_NAME, dune, 'epub', 2)).toBe('/Books/Dune - Frank Herbert (2).epub');
    expect(expandPath('/Books/<Author Sort:1>/<author-sort>', '<year> <title>', dune, 'epub')).toBe('/Books/H/Herbert, Frank/1965 Dune.epub');
    const sappho = createItem({ title: 'Lyrics', metadata: { originallyPublished: '-0570' } });
    expect(expandPath('/Books', '<year> <title>', sappho, 'epub')).toBe('/Books/570 BC Lyrics.epub');
  });

  it('makes details safe for SD cards', () => {
    expect(expandPath('/Books/<authors>', DEFAULT_FILE_NAME, odd, 'txt')).toBe(
      '/Books/AC DC & Someone Else/What A Title Part 1 2... - AC DC.txt',
    );
  });

  it('keeps optional sections only when everything in them has a value, and leaves out empty folders', () => {
    const folder = '/Books/<author>/[<series>/]';
    const file = '[<series> <seriesIndex> - ]<title>';
    expect(expandPath(folder, file, dune, 'epub')).toBe('/Books/Frank Herbert/Dune/Dune 1 - Dune.epub');
    expect(expandPath(folder, file, anonymous, 'epub')).toBe('/Books/Beowulf.epub');
    expect(expandFolder('/Books/<series>/<title>', anonymous)).toBe('/Books/Beowulf');
    expect(expandPath('/Books', DEFAULT_FILE_NAME, anonymous, 'pdf')).toBe('/Books/Beowulf.pdf');
  });

  it('finds the fixed part to look in, and reports mistakes', () => {
    expect(templateRoot('/library/<author>/<title>/')).toBe('/library');
    expect(templateRoot('/Books/')).toBe('/Books');
    expect(templateRoot('[<series>]/x')).toBe('/');
    expect(templateProblems('/library/<author>/<title>/')).toEqual([]);
    expect(templateProblems('/x/<autor>/[<series>')).toEqual([
      '<autor> isn’t a detail nexlibris knows.',
      'A [ or ] doesn’t pair up (and sections can’t be nested).',
    ]);
  });
});
