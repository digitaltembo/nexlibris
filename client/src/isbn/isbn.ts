import type { Item, Library } from '@nexlibris/common';

/**
 * ISBNs: checking, converting, and finding books by one. ISBNs are compared as ISBN-13, since
 * a book's ISBN-10 (in older EPUBs) and the EAN-13 barcode on its back are the same number.
 */

/** The ISBN-13 a string holds (an ISBN-10 or -13, with or without hyphens, spaces or an "ISBN" prefix), if it's valid. */
export function normalizeIsbn(text: string): string | undefined {
  const compact = text.replace(/^\s*isbn(?:-1[03])?:?/i, '').replace(/[\s-]/g, '').toUpperCase();
  if (/^\d{9}[\dX]$/.test(compact)) return isbn10Valid(compact) ? isbn10to13(compact) : undefined;
  if (/^97[89]\d{10}$/.test(compact)) return isbn13Valid(compact) ? compact : undefined;
  return undefined;
}

export function isbn10Valid(isbn: string): boolean {
  let sum = 0;
  for (let i = 0; i < 10; i++) sum += (10 - i) * (isbn[i] === 'X' ? 10 : Number(isbn[i]));
  return sum % 11 === 0;
}

export function isbn13Valid(isbn: string): boolean {
  return Number(isbn[12]) === isbn13CheckDigit(isbn.slice(0, 12));
}

function isbn13CheckDigit(first12: string): number {
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(first12[i]) * (i % 2 ? 3 : 1);
  return (10 - (sum % 10)) % 10;
}

export function isbn10to13(isbn10: string): string {
  const first12 = `978${isbn10.slice(0, 9)}`;
  return `${first12}${isbn13CheckDigit(first12)}`;
}

/** The ISBN-10 for an ISBN-13, which only 978- numbers have. */
export function isbn13to10(isbn13: string): string | undefined {
  if (!isbn13.startsWith('978')) return undefined;
  const first9 = isbn13.slice(3, 12);
  let sum = 0;
  for (let i = 0; i < 9; i++) sum += (10 - i) * Number(first9[i]);
  const check = (11 - (sum % 11)) % 11;
  return `${first9}${check === 10 ? 'X' : check}`;
}

/** Hyphen-free ISBN-13, grouped for reading: 978-0441172719. */
export const formatIsbn = (isbn13: string) => `${isbn13.slice(0, 3)}-${isbn13.slice(3)}`;

/** Whether an item records this ISBN (as an ISBN-13), in whichever form. */
export const hasIsbn = (item: Item, isbn13: string) =>
  Object.entries(item.identifiers).some(([key, value]) => key.startsWith('isbn') && normalizeIsbn(value) === isbn13);

/** Items in the library with this ISBN. */
export const itemsWithIsbn = (library: Library, isbn13: string): Item[] =>
  Object.values(library.items).filter((item) => hasIsbn(item, isbn13));
