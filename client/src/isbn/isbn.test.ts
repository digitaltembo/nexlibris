import { createItem, createLibrary } from '@nexlibris/common';
import { describe, expect, it } from 'vitest';
import { isbn10to13, isbn13to10, itemsWithIsbn, normalizeIsbn } from './isbn';
import { isbns } from './scanner';

describe('ISBNs', () => {
  it('accepts valid ISBN-10s and -13s in any common spelling, as ISBN-13', () => {
    expect(normalizeIsbn('9780441172719')).toBe('9780441172719');
    expect(normalizeIsbn('978-0-441-17271-9')).toBe('9780441172719');
    expect(normalizeIsbn('ISBN 0-441-17271-7')).toBe('9780441172719');
    expect(normalizeIsbn('isbn-10: 080442957x')).toBe('9780804429573');
    expect(normalizeIsbn('9791032305690')).toBe('9791032305690');
  });

  it('rejects bad check digits and numbers that aren’t ISBNs', () => {
    expect(normalizeIsbn('9780441172718')).toBeUndefined();
    expect(normalizeIsbn('0441172718')).toBeUndefined();
    // A grocery EAN-13 is a valid barcode but not a book.
    expect(normalizeIsbn('4006381333931')).toBeUndefined();
    expect(normalizeIsbn('')).toBeUndefined();
    expect(isbns(['4006381333931', '9780441172719', '9780441172719'])).toEqual(['9780441172719']);
  });

  it('converts between ISBN-10 and -13', () => {
    expect(isbn10to13('0441172717')).toBe('9780441172719');
    expect(isbn13to10('9780804429573')).toBe('080442957X');
    expect(isbn13to10('9791032305690')).toBeUndefined();
  });

  it('finds books by ISBN whichever form they record', () => {
    const old = createItem({ title: 'Dune', identifiers: { isbn: '0-441-17271-7' } });
    const other = createItem({ title: 'Emma', identifiers: { isbn: '9780141439587' } });
    const library = { ...createLibrary('L'), items: { [old.id]: old, [other.id]: other } };
    expect(itemsWithIsbn(library, '9780441172719')).toEqual([old]);
  });
});
