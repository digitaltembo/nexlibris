import { savePairing, type Pairing } from '@nexlibris/common';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { useEffect, useState } from 'react';
import { fn } from 'storybook/test';
import { connectionContents } from '../devices/contents';
import type { RemoteBook } from '../devices/types';
import { useLibrary } from '../library/LibraryContext';
import { connectionType } from '../plugins';
import { addInstances } from '../sync/instances';
import { SAMPLE_PLACED_PATH, sampleCatalog, sampleDevice } from '../stories/sampleLibrary';
import { ConnectionsDialog, ContentsView } from './ConnectionsDialog';

const meta = { component: ConnectionsDialog, args: { onClose: fn() } } satisfies Meta<typeof ConnectionsDialog>;
export default meta;
type Story = StoryObj<typeof meta>;

/** A reader and an OPDS catalog. Syncing the reader or looking at what's on it needs the reader on the network. */
export const Default: Story = {};

/** What the X4's index lists: Dune as a sync sent it, Emma put there by hand, and a book the library hasn't got. */
const onTheReader: RemoteBook[] = [
  { path: '/Books/Middlemarch - George Eliot.epub', size: 1_800_000, title: 'Middlemarch', author: 'George Eliot', tags: ['Classic'] },
  { path: '/Books/Emma - Jane Austen.epub', size: 890_000, title: 'Emma', author: 'Jane Austen' },
  { path: SAMPLE_PLACED_PATH, size: 980_000, title: 'Dune', author: 'Frank Herbert', series: 'Dune', seriesIndex: '1' },
];

function Contents({ device, books, note }: { device: typeof sampleDevice; books: RemoteBook[]; note?: string }) {
  const { library } = useLibrary();
  const current = library.devices?.[device.id] ?? device;
  const type = connectionType(device.type)!;
  return (
    <ContentsView
      type={type}
      contents={connectionContents(library, current, type, books)}
      {...(note && { note })}
      onLink={fn()}
      onImport={fn()}
    />
  );
}

/** "On it…" for a reader: each kind of book, and a chosen one not there yet (The Left Hand of Darkness). */
export const ReaderContents: Story = {
  render: () => <Contents device={sampleDevice} books={onTheReader} />,
};

/** Without the reader's library index, only the sync folders' files are listed, by name. */
export const ReaderWithoutIndex: Story = {
  render: () => (
    <Contents
      device={sampleDevice}
      books={onTheReader.map(({ path, size }) => ({ path, size }))}
      note="The reader’s library index couldn’t be read, so only the sync folders are listed. Opening the library on the reader makes one."
    />
  ),
};

/** "On it…" for a catalog: what its last export wrote. */
export const CatalogContents: Story = {
  render: () => <Contents device={sampleCatalog} books={[{ path: 'books/piranesi.epub', size: 420_000 }]} />,
};

const pairings: Pairing[] = [
  {
    hub: { origin: 'desktop-origin', name: 'Studio iMac', libraryName: 'Books' },
    address: 'http://192.168.0.11:47811',
    key: 'k',
    truth: 'theirs',
    base: { ours: 10, theirs: 12 },
    lastSyncedAt: '2026-10-01T18:30:00.000Z',
  },
  {
    hub: { origin: 'folder-origin', name: 'sync', libraryName: 'Sync folder' },
    address: 'folder:sync',
    key: 'folder',
    truth: 'theirs',
    lastSyncedAt: '2026-09-30T08:00:00.000Z',
  },
];

/** This browser paired with the desktop app and a sync folder; a phone the library syncs with, but not from here. */
function WithInstances({ onClose }: { onClose(): void }) {
  const { backend, apply } = useLibrary();
  const [ready, setReady] = useState(false);
  useEffect(() => {
    void (async () => {
      for (const pairing of pairings) await savePairing(backend, pairing);
      const library = await backend.getLibrary();
      await apply([
        ...addInstances(library, [{ origin: library.origin, name: 'Chrome on a Mac' }], 'tag:Classic'),
        ...addInstances(library, [
          { origin: 'desktop-origin', name: 'Studio iMac' },
          { origin: 'folder-origin', name: 'USB sync folder' },
          { origin: 'phone-origin', name: 'Pixel 8' },
        ]),
      ]);
      setReady(true);
    })();
  }, [backend, apply]);
  return ready ? <ConnectionsDialog onClose={onClose} /> : null;
}

/**
 * Other instances of nexlibris as connections, above the reader and catalog: this one (keeping only
 * its classics' files), two paired from here, and one that isn't. Adding one shows the ways to pair.
 */
export const WithOtherInstances: Story = { render: (args) => <WithInstances {...args} /> };
