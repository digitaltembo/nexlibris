import { createItem, type Creator } from '@nexlibris/common';
import { describe, expect, it } from 'vitest';
import { createLibrary } from '@nexlibris/common';
import { layoutProblems, placeBooks } from './fileLayout';

const herbert: Creator[] = [{ name: 'Frank Herbert', role: 'aut' }];
function libraryOf(...items: ReturnType<typeof createItem>[]) {
  const library = createLibrary('Test');
  for (const item of items) library.items[item.id] = item;
  return library;
}
const book = (title: string, hashes: [string, string][], addedAt: string, creators = herbert) =>
  createItem({ title, creators, files: hashes.map(([hash, format]) => ({ hash, size: 1, format })) }, addedAt);

describe('placing books in a folder', () => {
  it('puts each file in its book’s folder, with its format as the extension', () => {
    const dune = book('Dune', [['h1', 'epub'], ['h2', 'x4.epub']], '2026-01-01T00:00:00Z');
    const placed = placeBooks(libraryOf(dune), { folder: '<author>/<title>', fileName: '<title>' }, new Map());
    expect(Object.fromEntries(placed)).toEqual({ h1: 'Frank Herbert/Dune/Dune.epub', h2: 'Frank Herbert/Dune/Dune.x4.epub' });
  });

  it('numbers clashes, older books first, and keeps a file where it is while that fits', () => {
    const first = book('Dune', [['h1', 'epub']], '2026-01-01T00:00:00Z');
    const second = book('Dune', [['h2', 'epub']], '2026-01-02T00:00:00Z');
    const layout = { folder: '<author>', fileName: '<title>' };
    expect(Object.fromEntries(placeBooks(libraryOf(second, first), layout, new Map()))).toEqual({
      h1: 'Frank Herbert/Dune.epub',
      h2: 'Frank Herbert/Dune (2).epub',
    });
    // The second was there first: it keeps its name, and the other takes the next.
    expect(Object.fromEntries(placeBooks(libraryOf(second, first), layout, new Map([['h2', 'Frank Herbert/Dune.epub']])))).toEqual({
      h1: 'Frank Herbert/Dune (2).epub',
      h2: 'Frank Herbert/Dune.epub',
    });
  });

  it('places a file two books share once, and treats names differing in case as the same', () => {
    const a = book('dune', [['h1', 'epub']], '2026-01-01T00:00:00Z');
    const b = book('Dune', [['h1', 'epub'], ['h2', 'pdf'], ['h3', 'epub']], '2026-01-02T00:00:00Z');
    const placed = placeBooks(libraryOf(a, b), { folder: '<author>', fileName: '<title>' }, new Map());
    expect(Object.fromEntries(placed)).toEqual({ h1: 'Frank Herbert/dune.epub', h2: 'Frank Herbert/Dune.pdf', h3: 'Frank Herbert/Dune (2).epub' });
  });

  it('checks the templates', () => {
    expect(layoutProblems({ folder: '<author>/<nope>', fileName: '<title>' })).toHaveLength(1);
  });
});
