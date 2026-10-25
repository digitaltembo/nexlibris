import { createItem, MemoryStorage, StoredLibraryBackend, type Item, type LibraryBackend } from '@nexlibris/common';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseEpub } from '@nexlibris/tools/formats/epub';
import { buildEpub } from '@nexlibris/tools/formats/epubBuilder';
import { LibraryProvider, useLibrary } from '../library/LibraryContext';
import { ItemFiles } from './ItemFiles';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let backend: LibraryBackend;
let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let item: Item;

/** The item as the library has it now, as the book's details show it. */
function Files({ id }: { id: string }) {
  const { library } = useLibrary();
  const current = library.items[id];
  return current ? <ItemFiles item={current} onRead={() => undefined} /> : null;
}

beforeEach(async () => {
  backend = new StoredLibraryBackend(new MemoryStorage());
  const book = await buildEpub({ title: 'Dune', creators: [{ name: 'Frank Herbert', role: 'aut' }], tags: [], chapters: [{ id: 'c1', title: 'One', body: '<p>Hi</p>' }] });
  const stored = await backend.putFile(book);
  item = createItem({
    title: 'Dune',
    creators: [{ name: 'Frank Herbert', role: 'aut' }],
    tags: ['Science Fiction'],
    files: [
      { ...stored, format: 'epub', name: 'Dune.epub' },
      { hash: 'p'.repeat(64), size: 3, format: 'pdf', name: 'Dune.pdf' },
    ],
  });
  await backend.apply([{ type: 'addItem', item }]);
  container = document.body.appendChild(document.createElement('div'));
  root = createRoot(container);
  await act(async () =>
    root.render(
      <LibraryProvider open={() => Promise.resolve(backend)}>
        <Files id={item.id} />
      </LibraryProvider>,
    ),
  );
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

const button = (text: string) => [...document.querySelectorAll('button')].find((b) => b.textContent?.startsWith(text)) as HTMLButtonElement;
const click = (element: HTMLElement) => act(async () => element.click());
const menu = () => container.querySelector<HTMLButtonElement>('[aria-label="Actions for Dune.epub"]')!;

describe('a file’s Update file metadata', () => {
  it('writes the library’s metadata into the file and swaps it in, freeing the old', async () => {
    const old = item.files[0]!.hash;
    await click(menu());
    await click(button('Update file metadata'));
    const file = await vi.waitFor(async () => {
      const now = (await backend.getLibrary()).items[item.id]!.files.find((f) => f.format === 'epub')!;
      expect(now.hash).not.toBe(old);
      return now;
    });
    const parsed = await parseEpub((await backend.getFile(file.hash))!, 'Dune.epub', { cover: false });
    expect(parsed.tags).toEqual(['Science Fiction']);
    expect(await backend.hasFile(old)).toBe(false);
  });

  it('says so when the file already has the library’s metadata', async () => {
    const first = menu();
    await click(first);
    await click(button('Update file metadata'));
    // The row is the new file's once the library has it.
    await vi.waitFor(() => expect(menu()).not.toBe(first));
    await click(menu());
    await click(button('Update file metadata'));
    await vi.waitFor(() => expect(container.querySelector('[role=status]')?.textContent).toBe('It already says what the library does.'));
  });

  it('isn’t offered for formats nexlibris can’t write', async () => {
    await click(container.querySelector<HTMLButtonElement>('[aria-label="Actions for Dune.pdf"]')!);
    expect(button('Update file metadata')).toBeUndefined();
  });
});
