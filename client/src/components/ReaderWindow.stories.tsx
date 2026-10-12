import type { Meta, StoryObj } from '@storybook/react-vite';
import { useEffect, useRef, type ReactNode } from 'react';
import { useLibrary } from '../library/LibraryContext';
import { serveReaderWindows } from '../library/readerWindow';
import { sampleItems } from '../stories/sampleLibrary';
import { ReaderWindow } from './ReaderWindow';

/** The library's window answering, as `App` does, over the sample library. */
function LibraryWindow({ children }: { children: ReactNode }) {
  const { backend, library, apply } = useLibrary();
  const current = useRef(library);
  current.current = library;
  useEffect(() => serveReaderWindows(backend, () => current.current, apply), [backend, apply]);
  return <>{children}</>;
}

const dune = sampleItems[0]!;

const meta = {
  component: ReaderWindow,
  args: { itemId: dune.id, hash: dune.files[0]!.hash },
  decorators: [
    (Story) => (
      <LibraryWindow>
        <Story />
      </LibraryWindow>
    ),
  ],
} satisfies Meta<typeof ReaderWindow>;
export default meta;
type Story = StoryObj<typeof meta>;

/** A book's own window asking the library's for Dune, whose file the sample library doesn't store. */
export const FileMissing: Story = {};

/** A book the library no longer has. */
export const BookGone: Story = { args: { itemId: 'gone', hash: 'gone' } };
