import { createItem, MemoryStorage, StoredLibraryBackend, type Item, type LibraryBackend } from '@nexlibris/common';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import data from '../isbn/fixtures/dune-data.json';
import { LibraryProvider } from '../library/LibraryContext';
import type * as Generate from '../library/generateCover';
import { ItemDetail } from './ItemDetail';

// happy-dom has no canvas to draw on.
vi.mock('../library/generateCover', async (original) => ({
  ...(await original<typeof Generate>()),
  generateCover: vi.fn(async () => ({ data: new Blob([crypto.randomUUID()]), mediaType: 'image/jpeg' })),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** Open Library knowing Dune's edition and one more cover by search; covers are 4000 zero bytes. No network. */
const openLibrary = async (input: string | URL | Request) => {
  const url = new URL(String(input));
  if (url.host === 'covers.openlibrary.org') {
    return new Response(new Uint8Array(4000), { headers: { 'Content-Type': 'image/jpeg' } });
  }
  if (url.pathname === '/api/books') return Response.json(data);
  if (url.pathname === '/search.json') return Response.json({ docs: [{ cover_i: 11481354, title: 'Dune', first_publish_year: 1965 }] });
  return new Response('', { status: 404 });
};

let backend: LibraryBackend;
let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let item: Item;

beforeEach(async () => {
  vi.stubGlobal('fetch', vi.fn(openLibrary));
  backend = new StoredLibraryBackend(new MemoryStorage());
  const old = await backend.putFile(new Blob(['old cover']));
  item = createItem({
    title: 'Dune',
    creators: [{ name: 'Frank Herbert', role: 'aut' }],
    identifiers: { isbn: '9780441172719' },
    cover: { hash: old.hash, mediaType: 'image/png' },
  });
  await backend.apply([{ type: 'addItem', item }]);
  container = document.body.appendChild(document.createElement('div'));
  root = createRoot(container);
  await act(async () =>
    root.render(
      <LibraryProvider open={() => Promise.resolve(backend)}>
        <ItemDetail item={item} onClose={() => undefined} onSelectTag={() => undefined} onRead={() => undefined} />
      </LibraryProvider>,
    ),
  );
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

const button = (text: string) =>
  [...container.querySelectorAll('button')].find((b) => b.textContent?.startsWith(text)) as HTMLButtonElement;
const click = (element: HTMLElement) => act(async () => element.click());
const edit = async () => {
  await click(container.querySelector<HTMLButtonElement>('[aria-label="Actions for Dune"]')!);
  await click(button('Edit'));
};

describe('editing a cover', () => {
  it('finds covers on Open Library and saves the one chosen, deleting the old', async () => {
    await edit();
    await click(container.querySelector<HTMLButtonElement>('[aria-label="Change cover"]')!);
    await click(button('Find on Open Library'));
    const choices = [...container.querySelectorAll<HTMLButtonElement>('[aria-label="Covers from Open Library"] button')];
    expect(choices.map((c) => c.title)).toEqual(['ISBN 9780441172719', 'Dune, 1965']);
    await click(choices[1]!);
    expect(container.querySelector('img[alt="New cover"]')).not.toBeNull();
    expect(container.querySelector('[role=dialog]')).toBeNull();
    await click(button('Save'));

    // Saving stores the cover and frees the old one after the click's own work.
    const saved = await vi.waitFor(async () => {
      const current = (await backend.getLibrary()).items[item.id]!;
      expect(current.cover!.hash).not.toBe(item.cover!.hash);
      return current;
    });
    expect(saved.cover).toEqual({ hash: expect.any(String), mediaType: 'image/jpeg' });
    await vi.waitFor(async () => expect(await backend.hasFile(item.cover!.hash)).toBe(false));
  });

  it('generates a cover, again on asking, and saves the last', async () => {
    await edit();
    await click(container.querySelector<HTMLButtonElement>('[aria-label="Change cover"]')!);
    await click(button('Generate'));
    await click(button('Generate'));
    // Still open, to generate another.
    expect(container.querySelector('[role=dialog]')).not.toBeNull();
    await click(button('Save'));
    await vi.waitFor(async () => expect((await backend.getLibrary()).items[item.id]!.cover?.hash).not.toBe(item.cover!.hash));
  });

  it('changes nothing until saved', async () => {
    await edit();
    await click(container.querySelector<HTMLButtonElement>('[aria-label="Change cover"]')!);
    await click(button('Generate'));
    await click(button('Cancel'));
    expect((await backend.getLibrary()).items[item.id]!.cover).toEqual(item.cover);
  });
});
