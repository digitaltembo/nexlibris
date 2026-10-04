import { createItem, MemoryStorage, StoredLibraryBackend, type LibraryBackend } from '@nexlibris/common';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LibraryProvider } from '../library/LibraryContext';
import { TextIndexProvider, useTextIndex } from './TextIndexContext';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let state: ReturnType<typeof useTextIndex>;
let root: ReturnType<typeof createRoot> | undefined;

function Probe() {
  state = useTextIndex();
  return null;
}

async function mount(backend: LibraryBackend) {
  root = createRoot(document.createElement('div'));
  await act(async () =>
    root!.render(
      <LibraryProvider open={() => Promise.resolve(backend)}>
        <TextIndexProvider>
          <Probe />
        </TextIndexProvider>
      </LibraryProvider>,
    ),
  );
}

afterEach(async () => {
  await act(async () => root?.unmount());
});

const indexed = async (backend: LibraryBackend) =>
  Object.keys((await backend.readLocalState<{ files: Record<string, unknown> }>('fulltext'))?.files ?? {}).length;

describe('TextIndexProvider', () => {
  it('holds indexing while paused, and carries on when every pause is released', async () => {
    const backend = new StoredLibraryBackend(new MemoryStorage());
    for (const text of ['Call me Ishmael.', 'It was a dark and stormy night.']) {
      const { hash, size } = await backend.putFile(new Blob([text]));
      await backend.apply([{ type: 'addItem', item: createItem({ title: text, files: [{ hash, size, format: 'txt' }] }) }]);
    }
    await mount(backend);
    // As an import does: paused before indexing gets going (it finishes the book it's on).
    const first = state.pause();
    const second = state.pause();
    await act(() => new Promise((resolve) => setTimeout(resolve, 100)));
    const before = await indexed(backend);
    expect(before).toBeLessThan(2);

    first();
    first();
    await act(() => new Promise((resolve) => setTimeout(resolve, 100)));
    expect(await indexed(backend)).toBe(before);

    second();
    await vi.waitFor(async () => expect(await indexed(backend)).toBe(2));
  });
});
