import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LibraryIndexError, parseLibraryIndex, pathHash, recentBooks, storedPathHash } from './libraryIndex';

// A reader's index of 476 books (format 3, fold version 6, metadata on), from the firmware's benchmark card.
const fixture = async () => new Uint8Array(await readFile(join(process.cwd(), 'src/plugins/crosspoint/fixtures/library.idx')));

describe('parseLibraryIndex', () => {
  it('reads every book, with paths the reader’s own hashes agree with', async () => {
    const data = await fixture();
    const index = parseLibraryIndex(data);
    expect(index.metadataEnabled).toBe(true);
    expect(index.foldVersion).toBe(6);
    expect(index.books).toHaveLength(476);
    index.books.forEach((book, i) => expect(pathHash(book.path), book.path).toBe(storedPathHash(data, i)));
    expect(index.books[0]).toEqual({
      path: '/books/Haruki Murakami/1Q84 (72)/1Q84 - Haruki Murakami.x4.epub',
      folder: '/books/Haruki Murakami/1Q84 (72)',
      name: '1Q84 - Haruki Murakami.x4.epub',
      size: 1890131,
      title: '1Q84',
      author: 'Haruki Murakami',
      sourceAuthor: 'Haruki Murakami',
      authorSort: 'Murakami, Haruki',
      series: '',
      seriesIndex: '',
      tags: ['Literary', 'Fiction', 'xteink', 'L', '21st Century', 'Japanese', 'Read', 'Original Language -- Japanese'],
      metadata: 'extracted',
      modified: expect.stringMatching(/^20\d\d-/),
      firstSeen: expect.any(Number),
    });
    expect(index.books.filter((book) => book.series).length).toBeGreaterThan(0);
  });

  it('reads the lists: Recent, Title and Author first, then the generated ones', async () => {
    const index = parseLibraryIndex(await fixture());
    expect(index.lists.slice(0, 3).map((list) => [list.role, list.kind])).toEqual([
      ['recent', 'books'],
      ['title', 'identity'],
      ['author', 'books'],
    ]);
    expect(index.lists[1]!.books).toHaveLength(476);
    expect(new Set(index.lists[0]!.books).size).toBe(476);
    // Every child list is later than its parent, and every generated one is labelled.
    for (const [i, list] of index.lists.entries()) for (const child of list.lists) expect(child).toBeGreaterThan(i);
    const series = index.lists.find((list) => list.role === 'series')!;
    expect(series.kind).toBe('groups');
    expect(series.lists.length).toBeGreaterThan(0);
    expect(series.lists.every((n) => index.lists[n]!.role === 'generated' && index.lists[n]!.label)).toBe(true);
    expect(recentBooks(index)[0]).toBe(index.books[index.lists[0]!.books.at(-1)!]);
  });

  it('refuses files that aren’t an index of this version', async () => {
    expect(() => parseLibraryIndex(new TextEncoder().encode('not an index at all, but long enough to have a header....'))).toThrow(
      LibraryIndexError,
    );
    const old = await fixture();
    old[4] = 2;
    expect(() => parseLibraryIndex(old)).toThrow(/version 2, not 3/);
    const cut = (await fixture()).slice(0, 4000);
    expect(() => parseLibraryIndex(cut)).toThrow(/runs past the end/);
  });
});
