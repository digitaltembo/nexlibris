import { createItem, MemoryStorage, StoredLibraryBackend, type LibraryBackend } from '@nexlibris/common';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import data from '../isbn/fixtures/dune-data.json';
import edition from '../isbn/fixtures/dune-edition.json';
import series from '../isbn/fixtures/dune-series.json';
import work from '../isbn/fixtures/dune-work.json';
import { LibraryProvider } from '../library/LibraryContext';
import { IsbnDialog } from './IsbnDialog';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** Open Library as recorded for Dune; anything else is unknown. No network. */
const openLibrary = async (input: string | URL | Request) => {
  const url = new URL(String(input));
  if (url.host === 'covers.openlibrary.org') {
    return new Response(new Uint8Array(4000), { headers: { 'Content-Type': 'image/jpeg' } });
  }
  const routes: Record<string, unknown> = {
    '/books/OL59726263M.json': edition,
    '/works/OL893414W.json': work,
    '/series/OL331367L.json': series,
  };
  if (url.pathname === '/api/books') return Response.json(url.search.includes('9780441172719') ? data : {});
  return url.pathname in routes ? Response.json(routes[url.pathname]) : new Response('', { status: 404 });
};

let backend: LibraryBackend;
let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
const onOpen = vi.fn();

beforeEach(async () => {
  vi.stubGlobal('fetch', vi.fn(openLibrary));
  backend = new StoredLibraryBackend(new MemoryStorage());
  container = document.body.appendChild(document.createElement('div'));
  root = createRoot(container);
  await act(async () =>
    root.render(
      <LibraryProvider open={() => Promise.resolve(backend)}>
        <IsbnDialog onClose={() => undefined} onOpen={onOpen} />
      </LibraryProvider>,
    ),
  );
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  onOpen.mockReset();
});

const results = () => container.querySelector('ul')?.textContent ?? '';
const alert = () => container.querySelector('[role=alert]')?.textContent;
const button = (text: string) =>
  [...container.querySelectorAll('button')].find((b) => b.textContent?.startsWith(text)) as HTMLButtonElement;

async function lookUp(isbn: string) {
  const input = container.querySelector<HTMLInputElement>('input[aria-label=ISBN]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, isbn);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => {
    container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });
  await settle();
}

/** Lets lookups and adds (requests, then storing) finish. */
const settle = () => act(() => new Promise<void>((resolve) => setTimeout(resolve, 20)));

async function click(text: string) {
  await act(async () => button(text).click());
  await settle();
}

describe('IsbnDialog', () => {
  it('looks up a typed ISBN and adds the book, with its cover and no file', async () => {
    await lookUp('0-441-17271-7');
    expect(results()).toContain('Dune');
    expect(results()).toContain('Frank Herbert · 2020 · Ace');

    await click('Add');
    const items = Object.values((await backend.getLibrary()).items);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      title: 'Dune',
      files: [],
      identifiers: { isbn: '9780441172719' },
      metadata: { series: 'Dune', seriesIndex: 1 },
      cover: { mediaType: 'image/jpeg' },
    });

    await click('Added');
    expect(onOpen).toHaveBeenCalledWith(items[0]!.id);
  });

  it('says when an ISBN isn’t valid, and offers to add one Open Library doesn’t know', async () => {
    await lookUp('12345');
    expect(alert()).toBe('“12345” isn’t a valid ISBN.');

    await lookUp('9780141439587');
    expect(results()).toContain('Open Library doesn’t know this ISBN.');
    await click('Add anyway');
    const [item] = Object.values((await backend.getLibrary()).items);
    expect(item).toMatchObject({ title: 'ISBN 978-0141439587', identifiers: { isbn: '9780141439587' } });
  });

  it('shows books already in the library, matched by ISBN-10 too', async () => {
    const old = createItem({ title: 'My Dune', identifiers: { isbn: '0441172717' } });
    await act(async () => {
      await backend.apply([{ type: 'addItem', item: old }]);
    });
    await act(async () =>
      root.render(
        <LibraryProvider open={() => Promise.resolve(backend)}>
          <IsbnDialog onClose={() => undefined} onOpen={onOpen} />
        </LibraryProvider>,
      ),
    );
    await lookUp('9780441172719');
    expect(results()).toContain('In library · Open');
    await click('In library');
    expect(onOpen).toHaveBeenCalledWith(old.id);
  });
});
