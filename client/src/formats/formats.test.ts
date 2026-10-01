import { describe, expect, it } from 'vitest';
import { formatFromName, splitTags, titleFromFilename } from './formats';
import { decodeText } from './text';

describe('formatFromName', () => {
  it('recognizes supported formats, including compound extensions', () => {
    expect(formatFromName('Book.EPUB')).toBe('epub');
    expect(formatFromName('Book.x4.epub')).toBe('x4.epub');
    expect(formatFromName('My.Book.epub')).toBe('epub');
    expect(formatFromName('issue 1.cbr')).toBe('cbr');
    expect(formatFromName('notes.doc')).toBeUndefined();
    expect(formatFromName('README')).toBeUndefined();
  });

  it('derives titles from filenames', () => {
    expect(titleFromFilename('moby_dick.txt')).toBe('moby dick');
    expect(titleFromFilename('Book.x4.epub')).toBe('Book');
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
