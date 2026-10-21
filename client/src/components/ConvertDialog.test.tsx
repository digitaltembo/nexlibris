import { createItem, MemoryStorage, StoredLibraryBackend, type Item } from '@nexlibris/common';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LibraryProvider } from '../library/LibraryContext';
import { BulkConvertDialog } from './BulkConvertDialog';
import { ConvertDialog } from './ConvertDialog';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

const mobi = createItem({ title: 'Dune', files: [{ hash: 'm'.repeat(64), size: 1, format: 'mobi', name: 'Dune.mobi' }] });
const epub = createItem({ title: 'Emma', files: [{ hash: 'e'.repeat(64), size: 1, format: 'epub', name: 'Emma.epub' }] });

async function render(element: React.ReactNode) {
  const backend = new StoredLibraryBackend(new MemoryStorage());
  await backend.apply([mobi, epub].map((item) => ({ type: 'addItem', item }) as const));
  await act(async () => root.render(<LibraryProvider open={() => Promise.resolve(backend)}>{element}</LibraryProvider>));
}

const selects = () => [...document.querySelectorAll('select')];
async function choose(select: HTMLSelectElement, value: string) {
  await act(async () => {
    select.value = value;
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
}
const note = () => document.querySelector('[role="note"]')?.textContent ?? '';
const labels = () => [...document.querySelectorAll('label')].map((l) => l.textContent ?? '');

beforeEach(() => {
  container = document.body.appendChild(document.createElement('div'));
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe('ConvertDialog', () => {
  it('offers every format reached, warns of indirect ones, and asks only for the options of the path chosen', async () => {
    await render(<ConvertDialog item={mobi as Item} onClose={() => undefined} />);
    const [from, to] = selects();
    expect([...from!.options].map((o) => o.text)).toEqual(['MOBI']);
    expect([...to!.options].map((o) => o.text)).toContain('EPUB (X4) (indirect)');
    await choose(to!, 'epub');
    expect(note()).toBe('');
    expect(labels().length).toBe(2);
    await choose(to!, 'x4.epub');
    expect(note()).toContain('MOBI → EPUB → EPUB (X4)');
    expect(labels().length).toBeGreaterThan(2);
    await choose(to!, 'azw3');
    expect(labels().length).toBe(2);
  });
});

describe('BulkConvertDialog', () => {
  it('picks each book’s easiest file, or converts from the format chosen', async () => {
    await render(<BulkConvertDialog items={[mobi, epub]} onClose={() => undefined} />);
    const [from, to] = selects();
    expect([...from!.options].map((o) => o.text)).toEqual(['Pick best (least lost for each book)', 'MOBI', 'EPUB']);
    await choose(to!, 'x4.epub');
    expect(document.body.textContent).toContain('All 2 books will get a copy in EPUB (X4)');
    expect(note()).toContain('1 book converts indirectly: MOBI → EPUB → EPUB (X4)');
    await choose(from!, 'epub');
    expect(document.body.textContent).toContain('1 of 2 books will get');
    expect(note()).toBe('');
  });
});
