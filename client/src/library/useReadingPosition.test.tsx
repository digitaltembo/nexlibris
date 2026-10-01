import {
  createItem,
  LOCAL_USER,
  MemoryStorage,
  StoredLibraryBackend,
  userData,
  type FileRef,
  type Item,
  type LibraryBackend,
} from '@nexlibris/common';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LibraryProvider } from './LibraryContext';
import { savedPosition, useReadingPosition } from './useReadingPosition';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const epub: FileRef = { hash: 'aaa', format: 'epub', size: 1 };
const pdf: FileRef = { hash: 'bbb', format: 'pdf', size: 1 };

let backend: LibraryBackend;
let item: Item;
let hook: ReturnType<typeof useReadingPosition>;
let root: ReturnType<typeof createRoot> | undefined;

function Probe({ file }: { file: FileRef }) {
  hook = useReadingPosition(item.id, file);
  return null;
}

async function mount(file: FileRef) {
  root = createRoot(document.createElement('div'));
  const open = () => Promise.resolve(backend);
  await act(async () =>
    root!.render(
      <LibraryProvider open={open}>
        <Probe file={file} />
      </LibraryProvider>,
    ),
  );
}

const saved = async () => userData(await backend.getLibrary()).positions?.[item.id];

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  backend = new StoredLibraryBackend(new MemoryStorage());
  item = createItem({ title: 'Book', files: [epub, pdf] });
  await backend.apply([{ type: 'addItem', item }]);
});

afterEach(async () => {
  await act(async () => root?.unmount());
  vi.useRealTimers();
});

describe('useReadingPosition', () => {
  it('saves only once the position settles', async () => {
    await mount(epub);
    expect(hook.initial).toBeUndefined();
    await act(async () => {
      hook.report('cfi-1', 0.1);
      vi.advanceTimersByTime(1000);
      hook.report('cfi-2', 0.2);
      vi.advanceTimersByTime(1000);
    });
    expect(await saved()).toBeUndefined();
    await act(async () => vi.advanceTimersByTime(3000));
    expect(await saved()).toMatchObject({ hash: 'aaa', locator: 'cfi-2', progress: 0.2 });
    // Only the settled position made it into the change log.
    const changes = await backend.getChanges(0);
    expect(changes.filter((c) => c.op.type === 'setPosition')).toHaveLength(1);
  });

  it('saves what is pending when the reader closes, and opens there next time', async () => {
    await mount(epub);
    await act(async () => hook.report('cfi-9', 0.9));
    await act(async () => root!.unmount());
    root = undefined;
    expect(await saved()).toMatchObject({ locator: 'cfi-9' });

    await mount(epub);
    expect(hook.initial).toBe('cfi-9');
    expect(savedPosition(await backend.getLibrary(), item.id)?.file).toEqual(epub);
  });

  it('does not re-save an unchanged position, and ignores positions in other files', async () => {
    await backend.apply([
      { type: 'setPosition', userId: LOCAL_USER, itemId: item.id, position: { hash: 'aaa', locator: '3' } },
    ]);
    await mount(epub);
    const before = (await backend.getChanges(0)).length;
    await act(async () => {
      hook.report('3');
      vi.advanceTimersByTime(5000);
    });
    expect((await backend.getChanges(0)).length).toBe(before);
    await act(async () => root!.unmount());

    await mount(pdf);
    expect(hook.initial).toBeUndefined();
  });
});
