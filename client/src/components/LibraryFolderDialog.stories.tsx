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
      name: '/Users/you/Library/Application Support/nexlibris/library',
      desktop: {} as MessageClient<LibraryFolderApi>['libraryFolder'],
    },
  },
};

/** In a folder of the user’s: changing the layout offers to move the books to match. */
export const InFolder: Story = {
  args: {
    place: { kind: 'folder', name: 'Books', placed: new PlacedLibraryBackend(new MemoryStorage(), { ...DEFAULT_LAYOUT, folder: '<author>/[<series>/]' }, placeBooks) },
  },
};

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
