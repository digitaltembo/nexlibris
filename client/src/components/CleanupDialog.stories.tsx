import { createItem, type Creator } from '@nexlibris/common';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { fn } from 'storybook/test';
import { LibraryProvider } from '../library/LibraryContext';
import { openSampleLibrary, sampleItems } from '../stories/sampleLibrary';
import { CleanupDialog, Duplicates, RereadSummary } from './CleanupDialog';
import { Modal } from './Modal';

/** The sample library with copies of two books, as importing a Calibre library alongside it would leave. */
async function openWithDuplicates() {
  const backend = await openSampleLibrary();
  const [dune, , piranesi] = sampleItems;
  const copy = (title: string, creators: Creator[], format: string, addedAt: string, metadata = {}) =>
    createItem({ title, creators, metadata, files: [{ hash: crypto.randomUUID().replaceAll('-', '').repeat(2), size: 1, format }] }, addedAt);
  await backend.apply(
    [
      copy(dune!.title, dune!.creators, 'pdf', '2026-09-30T10:00:00Z', { series: 'Dune' }),
      copy(dune!.title.toUpperCase(), dune!.creators, 'mobi', '2026-10-01T10:00:00Z'),
      copy(piranesi!.title, piranesi!.creators, 'epub', '2026-10-02T10:00:00Z'),
    ].map((item) => ({ type: 'addItem', item })),
  );
  return backend;
}

const meta = {
  component: CleanupDialog,
  args: { onClose: fn() },
} satisfies Meta<typeof CleanupDialog>;
export default meta;
type Story = StoryObj<typeof meta>;

/** The cleanups on offer, each behind its button. */
export const Cleanups: Story = {};

const withDuplicates: Story['decorators'] = [
  (Story) => (
    <LibraryProvider open={openWithDuplicates}>
      <Story />
    </LibraryProvider>
  ),
];

/** Two books with copies: choose which to keep, untick any that aren't the same book, then merge. */
export const SameTitleAndAuthor: Story = {
  decorators: withDuplicates,
  render: (args) => <Duplicates onBack={fn()} onClose={args.onClose} />,
};

/** The sample library as it is: nothing to merge. */
export const NoDuplicates: Story = { render: (args) => <Duplicates onBack={fn()} onClose={args.onClose} /> };

/** After re-reading metadata: what was filled in, the books whose files are elsewhere, and ones that couldn't be read. */
export const RereadDone: Story = {
  render: (args) => (
    <Modal title="Re-read metadata" onClose={args.onClose}>
      <RereadSummary
        result={{
          updated: 412,
          filled: 1873,
          notHere: 6,
          failed: [{ title: 'Oxford Dictionary of English', message: 'This book is DRM-protected, so its text can’t be read.' }],
        }}
      />
    </Modal>
  ),
};
