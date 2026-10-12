import { createItem, LOCAL_USER, MemoryStorage, StoredLibraryBackend, userData, type Library } from '@nexlibris/common';
import { afterEach, describe, expect, it } from 'vitest';
import { readerAddress, readerUrl, requestBook, serveReaderWindows } from './readerWindow';

const stops: (() => void)[] = [];
afterEach(() => stops.splice(0).forEach((stop) => stop()));

async function libraryWindow() {
  const backend = new StoredLibraryBackend(new MemoryStorage());
  const { hash, size } = await backend.putFile(new Blob(['the book']));
  const item = createItem({ title: 'Dune', files: [{ hash, size, format: 'epub' }] });
  let library: Library = await backend.apply([
    { type: 'addItem', item },
    { type: 'setPosition', userId: LOCAL_USER, itemId: item.id, position: { hash, locator: 'epubcfi(/6/4)' } },
  ]);
  stops.push(
    serveReaderWindows(backend, () => library, async (ops) => {
      library = await backend.apply(ops);
    }),
  );
  return { item, hash, library: () => library };
}

describe('reader windows', () => {
  it('put the book in the address, and read it back', () => {
    const url = readerUrl({ itemId: 'i1', hash: 'h1', at: '12' }, 'https://example.test/app/?q=x#y');
    expect(url).toBe('https://example.test/app/?read=i1&file=h1&at=12');
    expect(readerAddress(new URL(url).search)).toEqual({ itemId: 'i1', hash: 'h1', at: '12' });
    expect(readerAddress('?q=x')).toBeUndefined();
  });

  it('get the book from the library’s window, and send it where the reader moves', async () => {
    const { item, hash, library } = await libraryWindow();
    const request = requestBook({ itemId: item.id, hash });
    stops.push(request.close);
    const book = await request.book;
    expect(book).toMatchObject({ title: 'Dune', file: { hash, format: 'epub' }, position: 'epubcfi(/6/4)' });
    // Browsers clone the file's Blob whole; Node's channel keeps only its fields, so its being there is what's checked.
    expect(book.data).toBeDefined();

    request.sendPosition(book, 'epubcfi(/6/8)', 0.5);
    await expect.poll(() => userData(library()).positions?.[item.id]).toMatchObject({ hash, locator: 'epubcfi(/6/8)', progress: 0.5 });
  });

  it('say when the library no longer has the book', async () => {
    const { item } = await libraryWindow();
    const request = requestBook({ itemId: item.id, hash: 'gone' });
    stops.push(request.close);
    await expect(request.book).rejects.toThrow(/no longer in the library/);
  });
});
