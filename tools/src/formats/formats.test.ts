import { describe, expect, it } from 'vitest';
import { EPUB_FORMATS, FORMATS, formatFromName, isEpub, READ_PREFERENCE, registerFormats, splitTags, titleFromFilename, type FormatId } from './formats';
import { decodeText } from './text';

// A plugin's EPUB for a reader, as a plugin's package would add one.
registerFormats({ 'r1.epub': { label: 'EPUB (R1)', mediaType: 'application/epub+zip', epub: true } });

describe('registerFormats', () => {
  it('adds plugins’ formats, an EPUB variant among the EPUBs, read after `epub`', () => {
    expect(FORMATS['r1.epub' as FormatId].label).toBe('EPUB (R1)');
    expect(isEpub('r1.epub')).toBe(true);
    expect(EPUB_FORMATS).toEqual(['epub', 'r1.epub']);
    expect(READ_PREFERENCE.slice(0, 3)).toEqual(['epub', 'r1.epub', 'azw3']);
  });
});

describe('formatFromName', () => {
  it('recognizes supported formats, including compound extensions', () => {
    expect(formatFromName('Book.EPUB')).toBe('epub');
    expect(formatFromName('Book.r1.epub')).toBe('r1.epub');
    expect(formatFromName('My.Book.epub')).toBe('epub');
    expect(formatFromName('issue 1.cbr')).toBe('cbr');
    expect(formatFromName('notes.doc')).toBeUndefined();
    expect(formatFromName('README')).toBeUndefined();
  });

  it('derives titles from filenames', () => {
    expect(titleFromFilename('moby_dick.txt')).toBe('moby dick');
    expect(titleFromFilename('Book.r1.epub')).toBe('Book');
  });
});

describe('splitTags', () => {
  it('splits entries that hold several tags and drops duplicates', () => {
    expect(splitTags(['Fantasy, Adventure;Magic', ' fantasy ', '', 'Young Adult'])).toEqual([
      'Fantasy',
      'Adventure',
      'Magic',
      'Young Adult',
    ]);
  });
});

describe('decodeText', () => {
  const bytes = (...b: number[]) => new Uint8Array(b).buffer;

  it('decodes UTF-8, dropping a BOM', () => {
    expect(decodeText(bytes(0xef, 0xbb, 0xbf, 0x43, 0x61, 0x66, 0xc3, 0xa9))).toBe('Café');
  });

  it('falls back to Windows-1252 for invalid UTF-8', () => {
    expect(decodeText(bytes(0x43, 0x61, 0x66, 0xe9, 0x93))).toBe('Café“');
  });
});
