import { MemoryStorage, StoredLibraryBackend } from '@nexlibris/common';
import { describe, expect, it } from 'vitest';
import data from './fixtures/dune-data.json';
import edition from './fixtures/dune-edition.json';
import series from './fixtures/dune-series.json';
import work from './fixtures/dune-work.json';
import { fetchCover, findCovers, itemFromBook, lookupIsbn, parseSeries, publishedDate, tagsFrom } from './openLibrary';

/** Open Library as recorded (trimmed responses for Dune), plus a cover; no network. */
function openLibrary(responses: Record<string, unknown> = {}) {
  const requested: string[] = [];
  const routes: Record<string, unknown> = {
    '/api/books?bibkeys=ISBN:9780441172719&format=json&jscmd=data': data,
    '/books/OL59726263M.json': edition,
    '/works/OL893414W.json': work,
    '/series/OL331367L.json': series,
    ...responses,
  };
  const fetchFn = (async (input: string) => {
    const url = new URL(input);
    requested.push(url.pathname + url.search);
    if (url.host === 'covers.openlibrary.org') {
      return new Response(new Uint8Array(4000), { headers: { 'Content-Type': 'image/jpeg' } });
    }
    const body = routes[url.pathname + url.search];
    return body === undefined ? new Response('Not found', { status: 404 }) : Response.json(body);
  }) as typeof fetch;
  return { fetchFn, requested };
}

describe('Open Library lookup', () => {
  it('reads an edition, its work and its series into an item', async () => {
    const { fetchFn, requested } = openLibrary();
    const book = await lookupIsbn('9780441172719', fetchFn);
    expect(book).toEqual({
      isbn: '9780441172719',
      title: 'Dune',
      creators: [{ name: 'Frank Herbert', role: 'aut' }],
      identifiers: { isbn: '9780441172719', openlibrary: 'OL59726263M', goodreads: '44767458' },
      tags: [
        'Fiction',
        'Science fiction',
        'Science-fiction',
        'American literature',
        'Hugo Award Winner',
        'American Science fiction',
        'Ecology',
        'Fantasy fiction',
      ],
      metadata: {
        publisher: 'Ace',
        published: '2020',
        originallyPublished: '1965',
        pages: 896,
        language: 'en',
        description: 'A placeholder description of the work.',
        series: 'Dune',
        seriesIndex: 1,
      },
      coverUrl: 'https://covers.openlibrary.org/b/id/15110282-L.jpg',
      url: 'https://openlibrary.org/books/OL59726263M/Dune',
    });
    expect(requested).toHaveLength(4);

    const backend = new StoredLibraryBackend(new MemoryStorage());
    const item = await itemFromBook(backend, book!, fetchFn);
    expect(item).toMatchObject({ title: 'Dune', files: [], identifiers: { isbn: '9780441172719' }, cover: { mediaType: 'image/jpeg' } });
    expect((await backend.getFile(item.cover!.hash))?.size).toBe(4000);
  });

  it('still finds the book when the edition and work records can’t be had', async () => {
    const { fetchFn } = openLibrary({ '/books/OL59726263M.json': undefined });
    const book = await lookupIsbn('9780441172719', fetchFn);
    expect(book?.title).toBe('Dune');
    expect(book?.metadata).toEqual({ publisher: 'Ace', published: '2020', pages: 896 });
  });

  it('says when it doesn’t know a book, and when it can’t be reached', async () => {
    const { fetchFn } = openLibrary({ '/api/books?bibkeys=ISBN:9780000000019&format=json&jscmd=data': {} });
    expect(await lookupIsbn('9780000000019', fetchFn)).toBeUndefined();
    const offline = (async () => {
      throw new TypeError('Failed to fetch');
    }) as typeof fetch;
    await expect(lookupIsbn('9780441172719', offline)).rejects.toThrow('Couldn’t reach Open Library (Failed to fetch).');
  });

  it('ignores Open Library’s placeholder for a missing cover', async () => {
    const tiny = (async () => new Response(new Uint8Array(43), { headers: { 'Content-Type': 'image/gif' } })) as typeof fetch;
    expect(await fetchCover('https://covers.openlibrary.org/b/id/1-L.jpg', tiny)).toBeUndefined();
  });

  it('finds covers by ISBN and by title and author, each once', async () => {
    const { fetchFn, requested } = openLibrary({
      '/search.json?title=Dune&fields=cover_i%2Ctitle%2Cfirst_publish_year&limit=20&author=Frank+Herbert': {
        docs: [
          { cover_i: 15110282, title: 'Dune', first_publish_year: 1965 },
          { cover_i: 11481354, title: 'Dune', first_publish_year: 1965 },
          { title: 'Dune (no cover)' },
          { cover_i: -1, title: 'Dune Messiah' },
        ],
      },
    });
    const covers = await findCovers({ isbns: ['978-0-441-17271-9'], title: 'Dune', authors: ['Frank Herbert'] }, fetchFn);
    expect(covers).toEqual([
      {
        url: 'https://covers.openlibrary.org/b/id/15110282-L.jpg',
        preview: 'https://covers.openlibrary.org/b/id/15110282-M.jpg',
        label: 'ISBN 9780441172719',
      },
      {
        url: 'https://covers.openlibrary.org/b/id/11481354-L.jpg',
        preview: 'https://covers.openlibrary.org/b/id/11481354-M.jpg',
        label: 'Dune, 1965',
      },
    ]);
    expect(requested).toHaveLength(2);
  });

  it('finds covers when one lookup fails, and throws when Open Library can’t be reached', async () => {
    const { fetchFn } = openLibrary();
    expect(await findCovers({ isbns: ['9780441172719'], title: 'Dune', authors: [] }, fetchFn)).toHaveLength(1);
    const offline = (async () => {
      throw new TypeError('Failed to fetch');
    }) as typeof fetch;
    await expect(findCovers({ isbns: [], title: 'Dune', authors: [] }, offline)).rejects.toThrow('Couldn’t reach Open Library (Failed to fetch).');
  });

  it('tidies dates, series and subjects', () => {
    expect(publishedDate('2020')).toBe('2020');
    expect(publishedDate('October 1, 1990')).toBe('1990-10-01');
    expect(publishedDate('June 1990')).toBe('1990-06');
    expect(publishedDate('c1985')).toBe('c1985');
    expect(parseSeries('Dune chronicles -- bk. 1')).toEqual({ name: 'Dune chronicles', index: 1 });
    expect(parseSeries('Discworld ; 12')).toEqual({ name: 'Discworld', index: 12 });
    expect(parseSeries('Foundation, #2')).toEqual({ name: 'Foundation', index: 2 });
    expect(parseSeries('Penguin classics')).toEqual({ name: 'Penguin classics' });
    expect(tagsFrom(['Fiction', 'fiction', 'nyt:trade-fiction=2021', 'open_syllabus_project', 'Dune (Imaginary place)', 'Accessible book', 'Fiction, science fiction, general'])).toEqual(['Fiction']);
  });
});
