import { MemoryStorage, PlacedLibraryBackend, type LibraryFolderApi, type MessageClient } from '@nexlibris/common';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { fn } from 'storybook/test';
import { DEFAULT_LAYOUT, placeBooks } from '../library/fileLayout';
import { ConfirmMove, LibraryFolderDialog } from './LibraryFolderDialog';
import { Modal } from './Modal';

const meta = {
  component: LibraryFolderDialog,
  args: { onClose: fn(), place: { kind: 'browser' } },
} satisfies Meta<typeof LibraryFolderDialog>;
export default meta;
type Story = StoryObj<typeof meta>;

/** In the browser’s own storage: the layout books would have in a folder, and choosing one. */
export const InBrowser: Story = {};

/** The desktop app, with the library in its data folder. */
export const InAppDataFolder: Story = {
  args: {
    place: {
      kind: 'app',
      app: 'desktop',
      name: '/Users/you/Library/Application Support/nexlibris/library',
      native: {} as MessageClient<LibraryFolderApi>['libraryFolder'],
    },
  },
};

/** Android, with the library in the app’s own storage: what a folder costs there. */
export const InAndroidApp: Story = {
  args: { place: { kind: 'app', app: 'android', name: '', native: {} as MessageClient<LibraryFolderApi>['libraryFolder'] } },
};

/** Android, having lost access to the folder the library was in, so it opened its own storage instead. */
export const AndroidLostFolder: Story = {
  args: {
    place: { kind: 'app', app: 'android', name: '', lost: 'Documents/Books', native: {} as MessageClient<LibraryFolderApi>['libraryFolder'] },
  },
};

/** In a folder of the user’s: changing the layout offers to move the books to match. */
export const InFolder: Story = {
  args: {
    place: { kind: 'folder', name: 'Books', placed: new PlacedLibraryBackend(new MemoryStorage(), { ...DEFAULT_LAYOUT, folder: '<author>/[<series>/]' }, placeBooks) },
  },
};

const server = { name: 'books.example.org', signup: false };
const signedIn = { ...server, account: { id: 'a', name: 'ada' } };
const empty = { exists: false, items: 0, files: 0, bytes: 0 };

/** On a page from a nexlibris server, signed out: signing in is offered, to keep the library in the account. */
export const ServerSignedOut: Story = { args: { session: server, onAccount: fn() } };

/** Signed in, with an empty account: moving the library there, or keeping a copy there that syncs. */
export const AccountEmpty: Story = { args: { session: signedIn, cloud: empty, onSyncWithAccount: fn() } };

/** Signed in, with a library in the account already: opening it instead, or syncing the two. */
export const AccountHasLibrary: Story = {
  args: { session: signedIn, cloud: { exists: true, items: 412, files: 380, bytes: 2.1e9 }, onSyncWithAccount: fn() },
};

/** The library is in the account: moving it back into this browser. */
export const InAccount: Story = { args: { session: signedIn, place: { kind: 'cloud', name: 'ada' } } };

/** Confirming the move to a folder with other files in it. */
export const ConfirmingMove: Story = {
  render: (args) => (
    <Modal title="Library folder" onClose={args.onClose}>
      <ConfirmMove
        target={{ name: '/Users/you/Documents/Books', holds: 'files' }}
        from="in the app’s data folder (/Users/you/Library/Application Support/nexlibris/library)"
        count={1655}
        bytes={6.1e9}
        example="Frank Herbert/Dune/Dune.epub"
        onMove={fn()}
        onBack={fn()}
      />
    </Modal>
  ),
};

const desktop = {
  kind: 'app' as const,
  app: 'desktop' as const,
  name: '/Users/you/Library/Application Support/nexlibris/library',
  native: {} as MessageClient<LibraryFolderApi>['libraryFolder'],
};

/** In the desktop app with no server chosen: choosing one (self-hosted, say) is offered. */
export const AppNoServer: Story = { args: { app: true, place: desktop, onAccount: fn() } };

/** In the desktop app, signed in to an empty account: copying the library there (the device keeps its own), or syncing a copy. */
export const AppAccountEmpty: Story = { args: { app: true, place: desktop, session: signedIn, cloud: empty, onSyncWithAccount: fn() } };

/** In an app using the account's library: opening the device's own again. */
export const AppInAccount: Story = { args: { app: true, session: signedIn, place: { kind: 'cloud', name: 'ada' } } };
