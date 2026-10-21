import { describe, expect, it } from 'vitest';
import { authorSortOf, compareDates, formatDate, formatYear, nameSortOf, normalizeDate, normalizeMetadata, titleSortOf } from './metadata';

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

  it('keeps years before AD 1 with a minus, counted with no year 0, and early years AD in four digits', () => {
    for (const bc of ['570 BC', '570 bce', 'c. 570 B.C.', '-570', '-0570']) expect(normalizeDate(bc)).toBe('-0570');
    expect(normalizeDate('-0570-03')).toBe('-0570-03');
    for (const ad of ['AD 8', '8 AD', '8 CE', '8', '0008']) expect(normalizeDate(ad)).toBe('0008');
    for (const none of ['0 BC', '0000', '-0000']) expect(normalizeDate(none)).toBeUndefined();
    expect(normalizeDate('1021')).toBe('1021');
  });
});

describe('dates for reading and in order', () => {
  it('shows the era where a year needs it', () => {
    expect(formatDate('-0570')).toBe('570 BC');
    expect(formatDate('-0570-03')).toBe('570-03 BC');
    expect(formatDate('0008')).toBe('AD 8');
    expect(formatDate('1965-08')).toBe('1965-08');
    expect(formatDate('sometime')).toBe('sometime');
    expect([formatYear('-0570'), formatYear('0008'), formatYear('1965-08-01'), formatYear(undefined)]).toEqual(['570 BC', 'AD 8', '1965', '']);
  });

  it('orders BC before AD, earlier BC years first, then by month and day', () => {
    const dates = ['1965-08', '-0400', '0008', 'sometime', '-0570', '1965', '1965-08-01', '-0570-03'];
    expect([...dates].sort((a, b) => compareDates(a, b))).toEqual(['-0570', '-0570-03', '-0400', '0008', '1965', '1965-08', '1965-08-01', 'sometime']);
    expect(compareDates('1965-08-15', '1965-08', 2)).toBe(0);
    expect(compareDates('-0570-03', '-0570', 1)).toBe(0);
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
