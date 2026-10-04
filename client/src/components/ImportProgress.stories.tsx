import type { Meta, StoryObj } from '@storybook/react-vite';
import { fn } from 'storybook/test';
import { ImportProgress } from './ImportProgress';

const meta = {
  component: ImportProgress,
  args: { onStop: fn(), progress: { phase: 'finding' } },
} satisfies Meta<typeof ImportProgress>;
export default meta;
type Story = StoryObj<typeof meta>;

/** The native picker is open, or the app is listing the folder chosen. */
export const Finding: Story = { args: { onStop: undefined } };

/** Looking through a folder dropped on the page. */
export const ReadingFolder: Story = { args: { progress: { phase: 'reading', found: 412 } } };

/** The native app copying a Calibre library into the library's files. */
export const Copying: Story = {
  args: {
    progress: {
      phase: 'copying',
      files: 1204,
      totalFiles: 3120,
      bytes: 1.9e9,
      totalBytes: 4.6e9,
      current: 'Calibre Library/Frank Herbert/Dune (7)/Dune - Frank Herbert.epub',
    },
  },
};

/** Adding the books, naming the one being added. */
export const Importing: Story = {
  args: { progress: { phase: 'importing', done: 87, total: 128, current: 'Twenty Thousand Leagues Under the Seas - Jules Verne.epub' } },
};
