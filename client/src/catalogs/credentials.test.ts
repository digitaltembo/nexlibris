import { MemoryStorage, StoredLibraryBackend } from '@nexlibris/common';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { authHeaders, basicAuthorization, catalogAuth, readCredentials, writeCredentials } from './credentials';
import { downloadBook, fetchSignedInImage, textFetcher } from './remote';

afterEach(() => vi.unstubAllGlobals());

describe('signing in to catalogs', () => {
  it('encodes Basic auth as UTF-8', () => {
    expect(basicAuthorization({ username: 'Aladdin', password: 'open sesame' })).toBe('Basic QWxhZGRpbjpvcGVuIHNlc2FtZQ==');
    expect(basicAuthorization({ username: 'zoë', password: 'π' })).toBe(`Basic ${Buffer.from('zoë:π').toString('base64')}`);
  });

  it('keeps sign-ins in local state, per connection, and forgets them', async () => {
    const backend = new StoredLibraryBackend(new MemoryStorage());
    await writeCredentials(backend, 'a', { username: 'reader', password: 'secret' });
    await writeCredentials(backend, 'b', { username: 'other', password: 'x' });
    expect(await readCredentials(backend, 'a')).toEqual({ username: 'reader', password: 'secret' });
    await writeCredentials(backend, 'a', undefined);
    expect(await readCredentials(backend, 'a')).toBeUndefined();
    expect(await readCredentials(backend, 'b')).toBeDefined();
    // Nothing of it in the library, which syncs and is backed up.
    expect(JSON.stringify(await backend.getLibrary())).not.toContain('other');
  });

  it('sends the sign-in only to the catalog’s own server', async () => {
    const backend = new StoredLibraryBackend(new MemoryStorage());
    await writeCredentials(backend, 'a', { username: 'reader', password: 'secret' });
    const auth = await catalogAuth(backend, 'a', 'https://books.example/opds/');
    expect(authHeaders(auth, 'https://books.example/opds/new.xml')).toEqual({ Authorization: basicAuthorization({ username: 'reader', password: 'secret' }) });
    expect(authHeaders(auth, 'https://cdn.example/cover.jpg')).toEqual({});
    expect(authHeaders(auth, 'http://books.example/opds/')).toEqual({});
    expect(await catalogAuth(backend, 'none', 'https://books.example/')).toBeUndefined();
  });

  it('fetches pages, books and covers with it in a browser', async () => {
    const auth = { origin: 'https://books.example', authorization: 'Basic eDp5' };
    const fetch = vi.fn(async (_url: string, _init?: RequestInit) => new Response('<feed/>', { status: 200 }));
    vi.stubGlobal('fetch', fetch);
    await textFetcher(auth)('https://books.example/opds/');
    await textFetcher(auth)('https://elsewhere.example/feed');
    await downloadBook('https://books.example/books/1.epub', 'epub', auth);
    expect(await fetchSignedInImage('https://cdn.example/cover.jpg', auth)).toBeUndefined();
    await fetchSignedInImage('https://books.example/covers/1.jpg', auth);
    const sent = fetch.mock.calls.map(([url, init]) => [url, (init?.headers as Record<string, string>)?.Authorization]);
    expect(sent).toEqual([
      ['https://books.example/opds/', 'Basic eDp5'],
      ['https://elsewhere.example/feed', undefined],
      ['https://books.example/books/1.epub', 'Basic eDp5'],
      ['https://books.example/covers/1.jpg', 'Basic eDp5'],
    ]);
  });

  it('says when the sign-in was refused', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 401 })));
    await expect(downloadBook('https://books.example/books/1.epub', 'epub')).rejects.toThrow(/refused the user name and password/);
  });
});
