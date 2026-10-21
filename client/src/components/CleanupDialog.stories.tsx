import { createItem, type Creator } from '@nexlibris/common';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { fn } from 'storybook/test';
import { LibraryProvider } from '../library/LibraryContext';
import { openSampleLibrary, sampleItems } from '../stories/sampleLibrary';
import { buildEpub } from '@nexlibris/tools/formats/epubBuilder';
import { CleanupDialog, Duplicates, FilesUpdated, RereadSummary, StaleFiles, UpdateFiles } from './CleanupDialog';
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

/** The sample library with EPUBs stored for two books: one's file lacks the library's tags and series, the other's matches. */
async function openWithFiles() {
  const backend = await openSampleLibrary();
  const [dune, , piranesi] = sampleItems;
  const store = async (title: string, creators: Creator[], tags: string[]) =>
    backend.putFile(await buildEpub({ title, creators, tags, chapters: [{ id: 'c1', title: 'One', body: '<p>Once.</p>' }] }));
  const library = await backend.getLibrary();
  const stale = await store(dune!.title, dune!.creators, []);
  const current = library.items[piranesi!.id]!;
  const matching = await store(current.title, current.creators, current.tags);
  await backend.apply([
    { type: 'attachFile', id: dune!.id, file: { ...stale, format: 'epub', name: 'Dune.epub' } },
    { type: 'attachFile', id: piranesi!.id, file: { ...matching, format: 'epub', name: 'Piranesi.epub' } },
  ]);
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

/** Checking the stored EPUBs against the library: Dune's file lacks its tags and series, so it's listed to update. */
export const UpdateBookFiles: Story = {
  decorators: [
    (Story) => (
      <LibraryProvider open={openWithFiles}>
        <Story />
      </LibraryProvider>
    ),
  ],
  render: (args) => <UpdateFiles onBack={fn()} onClose={args.onClose} />,
};

const dune = sampleItems[0]!;

/** What checking found in a bigger library: files to update and what differs in each, and books it couldn't check. */
export const FilesToUpdate: Story = {
  render: (args) => (
    <Modal title="Update book files" onClose={args.onClose}>
      <StaleFiles
        found={{
          stale: [
            { item: dune, file: { hash: 'a', size: 1, format: 'epub' }, changes: ['tags', 'series', 'series index'] },
            { item: dune, file: { hash: 'b', size: 1, format: 'x4.epub' }, changes: ['tags'] },
            { item: sampleItems[1]!, file: { hash: 'c', size: 1, format: 'epub' }, changes: ['title sort', 'author sort', 'description'] },
          ],
          fingerprints: [],
          current: 640,
          notHere: 12,
          drm: [{ title: 'A Bought Book', kind: 'Adobe DRM' }],
          failed: [{ title: 'Broken', message: 'Broken.epub is not a valid EPUB (not a zip archive)' }],
        }}
      />
    </Modal>
  ),
};

/** After updating. */
export const FilesUpdatedDone: Story = {
  render: (args) => (
    <Modal title="Update book files" onClose={args.onClose}>
      <FilesUpdated result={{ updated: 214, freed: 214, failed: [] }} />
    </Modal>
  ),
};
