import { createCategory, createItem, type Item } from '@nexlibris/common';
import { describe, expect, it } from 'vitest';
import { ALL_BOOKS, browse, crumbs, parentPath, viewCount, type BrowseView } from './browse';

const book = (title: string, fields: Partial<Item> & { series?: string; seriesIndex?: number; at?: string } = {}) => {
  const { series, seriesIndex, at, ...rest } = fields;
  return createItem(
    { title, ...rest, metadata: { ...(series && { series }), ...(seriesIndex !== undefined && { seriesIndex }) } },
    at ?? '2026-01-01T00:00:00.000Z',
  );
};
const herbert = { name: 'Frank Herbert', role: 'aut' as const };
const dune = book('Dune', { creators: [herbert], tags: ['Science Fiction', 'Classic'], series: 'Dune', seriesIndex: 1, at: '2026-01-03T00:00:00.000Z' });
const messiah = book('Dune Messiah', { creators: [herbert], tags: ['science fiction'], series: 'Dune', seriesIndex: 2, at: '2026-01-01T00:00:00.000Z' });
const emma = book('Emma', { creators: [{ name: 'Jane Austen', role: 'aut' }], tags: ['Classic', 'Romance'], at: '2026-01-02T00:00:00.000Z' });
const items = [messiah, emma, dune];

const moods = createCategory({ name: 'Moods', entries: [{ label: 'Old', query: 'tag:classic' }, { label: '', query: 'herbert' }] });
const favourites = createCategory({ name: 'Favourites', entries: [{ label: 'Fav', query: 'title:emma' }] });
const categories = [moods, favourites];

const labels = (view: BrowseView) => (view.kind === 'entries' ? view.entries.map((e) => `${e.label}: ${e.detail}`) : []);
const titles = (view: BrowseView) => (view.kind === 'books' ? view.items.map((i) => i.title) : []);

describe('browse', () => {
  it('shows a different book for each entry where it can, preferring ones with covers, and the same one each time', () => {
    const cover = { hash: 'c'.repeat(64), mediaType: 'image/jpeg' as const };
    // A book that sorts first and is in every entry, as 1Q84 was.
    const first = book('1Q84', { tags: ['Fiction', 'Japanese', 'Translated'], cover });
    const others = ['Fiction', 'Japanese', 'Translated'].map((tag) => book(`A ${tag} book`, { tags: [tag], cover }));
    const bare = book('A book without a cover', { tags: ['Fiction', 'Japanese', 'Translated'] });
    const all = [first, ...others, bare];
    const category = createCategory({
      name: 'Shelves',
      entries: ['Fiction', 'Japanese', 'Translated'].map((tag) => ({ label: tag, query: `tag:${tag}` })),
    });
    const samples = () => {
      const view = browse(all, ['category', category.id], [category]);
      return view.kind === 'entries' ? view.entries.map((e) => e.sample) : [];
    };
    const shown = samples();
    expect(new Set(shown).size).toBe(3);
    expect(shown.every((item) => item?.cover)).toBe(true);
    expect(samples()).toEqual(shown);
  });

  it('lists the categories at the Library, as calibre3opds does, with the user’s before Tags', () => {
    expect(labels(browse(items, [], categories))).toEqual([
      'All books: 3 books',
      'Recent books: 3 books',
      'Authors: 2 authors',
      'Series: 1 series',
      'Favourites: 1 book',
      'Moods: 2 entries',
      'Tags: 3 tags',
    ]);
  });

  it('goes from authors, series and tags to their books', () => {
    expect(labels(browse(items, ['authors'], categories))).toEqual(['Frank Herbert: 2 books', 'Jane Austen: 1 book']);
    expect(titles(browse(items, ['authors', 'Frank Herbert'], categories))).toEqual(['Dune Messiah', 'Dune']);
    // Tags match ignoring case, shown as spelled most often.
    expect(labels(browse(items, ['tags'], categories))).toEqual(['Classic: 2 books', 'Romance: 1 book', 'Science Fiction: 2 books']);
    expect(browse(items, ['tags', 'science fiction'], categories)).toMatchObject({ kind: 'books', items: [messiah, dune] });
    // Series and recent books have an order of their own; the rest take the user's.
    expect(browse(items, ['series', 'Dune'], categories)).toMatchObject({ kind: 'books', sort: { key: 'series', desc: false } });
    expect(browse(items, ['recent'], categories)).toMatchObject({ sort: { key: 'added', desc: true } });
    expect(browse(items, ALL_BOOKS, categories)).toEqual({ kind: 'books', items });
  });

  it('opens a category’s entries, or the books of one with a single entry', () => {
    expect(labels(browse(items, ['category', moods.id], categories))).toEqual(['Old: 2 books', 'herbert: 2 books']);
    expect(titles(browse(items, ['category', moods.id, '0'], categories)).sort()).toEqual(['Dune', 'Emma']);
    expect(titles(browse(items, ['category', favourites.id], categories))).toEqual(['Emma']);
    expect(browse(items, ['category', 'gone'], categories)).toEqual({ kind: 'missing' });
    expect(browse(items, ['category', moods.id, '9'], categories)).toEqual({ kind: 'missing' });
    expect(browse(items, ['nowhere'], categories)).toEqual({ kind: 'missing' });
  });

  it('narrows entries to the books the search leaves', () => {
    expect(labels(browse([emma], ['authors'], categories))).toEqual(['Jane Austen: 1 book']);
    expect(browse([emma], ['authors', 'Frank Herbert'], categories)).toEqual({ kind: 'books', items: [] });
  });
});

describe('crumbs', () => {
  it('names each level from the Library down', () => {
    expect(crumbs(items, ['tags', 'science fiction'], categories)).toEqual([
      { label: 'Library', path: [] },
      { label: 'Tags', path: ['tags'] },
      { label: 'Science Fiction', path: ['tags', 'science fiction'] },
    ]);
    expect(crumbs(items, ['category', moods.id, '1'], categories).map((c) => c.label)).toEqual(['Library', 'Moods', 'herbert']);
    expect(crumbs(items, ALL_BOOKS, categories).map((c) => c.label)).toEqual(['Library', 'All books']);
  });
});

it('counts what a view shows, and goes up a level', () => {
  expect(viewCount(browse(items, ['series'], categories))).toBe('1 series');
  expect(viewCount(browse(items, ['category', moods.id], categories))).toBe('2 entries');
  expect(viewCount(browse(items, ALL_BOOKS, categories))).toBe('3 books');
  expect(parentPath(['authors', 'Frank Herbert'])).toEqual(['authors']);
});
