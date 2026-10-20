import type { Meta, StoryObj } from '@storybook/react-vite';
import { useLibrary } from '../library/LibraryContext';
import { sampleItems } from '../stories/sampleLibrary';
import { ItemCatalogs } from './ItemCatalogs';

const meta = { component: ItemCatalogs, args: { item: sampleItems[0]! } } satisfies Meta<typeof ItemCatalogs>;
export default meta;
type Story = StoryObj<typeof meta>;

/** Reads the book from the library, so Remove from catalog shows. */
function Live({ item }: { item: (typeof sampleItems)[number] }) {
  const { library } = useLibrary();
  return <ItemCatalogs item={library.items[item.id] ?? item} />;
}

/** Dune, sent to the X4: at the bottom of its details. */
export const SentToReader: Story = { render: (args) => <Live {...args} /> };

/** Piranesi, in the Shelf catalog. */
export const InCatalog: Story = { args: { item: sampleItems[2]! }, render: (args) => <Live {...args} /> };
