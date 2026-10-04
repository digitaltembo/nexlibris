import { describe, expect, it } from 'vitest';
import { authorSortOf, nameSortOf, normalizeDate, normalizeMetadata, titleSortOf } from './metadata';
import { applyOperation, createItem, createLibrary } from './operations';

describe('normalizeDate', () => {
  it('keeps partial ISO dates, and takes timestamps to the day nearest them', () => {
    expect(normalizeDate('1965')).toBe('1965');
    expect(normalizeDate('1965-08')).toBe('1965-08');
    expect(normalizeDate(' 1965-08-01 ')).toBe('1965-08-01');
    // Calibre: local midnight in UTC, east and west of Greenwich.
    expect(normalizeDate('2010-05-11T22:00:00+00:00')).toBe('2010-05-12');
    expect(normalizeDate('2010-05-12T04:00:00+00:00')).toBe('2010-05-12');
    expect(normalizeDate('2010-05-11T18:30:00+00:00')).toBe('2010-05-12');
    expect(normalizeDate('2010-05-12T23:30:00')).toBe('2010-05-12');
    expect(normalizeDate('0101-01-01T00:00:00+00:00')).toBeUndefined();
    expect(normalizeDate('October 1, 1990')).toBe('1990-10-01');
    expect(normalizeDate('June 1990')).toBe('1990-06');
    expect(normalizeDate('sometime')).toBe('sometime');
    expect(normalizeDate('')).toBeUndefined();
  });
});

describe('normalizeMetadata', () => {
  it('normalizes the fixed fields and drops empty values, leaving other keys alone', () => {
    expect(normalizeMetadata({ seriesIndex: '2.5', pages: 'many', coverColor: '#AABBCC', originallyPublished: '1965-01-01T00:00:00Z', x: '', mood: 'cosy' })).toEqual({
      seriesIndex: 2.5,
      pages: 'many',
      coverColor: '#aabbcc',
      originallyPublished: '1965-01-01',
      mood: 'cosy',
    });
  });

  it('applies as items are made and fields set', () => {
    const item = createItem({ title: 'Dune', metadata: { published: 'August 1965' } });
    expect(item.metadata).toEqual({ published: '1965-08' });
    let library = applyOperation(createLibrary('Books'), { type: 'addItem', item }, '2026-01-01T00:00:00Z');
    library = applyOperation(library, { type: 'setMetadata', id: item.id, key: 'seriesIndex', value: '1' }, '2026-01-01T00:00:00Z');
    library = applyOperation(library, { type: 'setMetadata', id: item.id, key: 'published', value: '' }, '2026-01-01T00:00:00Z');
    expect(library.items[item.id]!.metadata).toEqual({ seriesIndex: 1 });
  });
});

describe('sorts', () => {
  it('moves articles to the end of titles', () => {
    expect(titleSortOf('The Left Hand of Darkness')).toBe('Left Hand of Darkness, The');
    expect(titleSortOf('A Wizard of Earthsea')).toBe('Wizard of Earthsea, A');
    expect(titleSortOf('Theory of Everything')).toBe('Theory of Everything');
  });

  it('puts surnames first, with their particles, and suffixes last', () => {
    expect(nameSortOf('Frank Herbert')).toBe('Herbert, Frank');
    expect(nameSortOf('Ursula K. Le Guin')).toBe('Le Guin, Ursula K.');
    expect(nameSortOf('Ludwig van Beethoven')).toBe('van Beethoven, Ludwig');
    expect(nameSortOf('Martin Luther King Jr.')).toBe('King, Martin Luther, Jr.');
    expect(nameSortOf('Homer')).toBe('Homer');
    expect(nameSortOf('Herbert, Frank')).toBe('Herbert, Frank');
    expect(authorSortOf(['Terry Pratchett', 'Neil Gaiman'])).toBe('Pratchett, Terry & Gaiman, Neil');
  });
});
