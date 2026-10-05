import type { Meta, StoryObj } from '@storybook/react-vite';
import { fn } from 'storybook/test';
import { useLibrary } from '../library/LibraryContext';
import { sampleItems } from '../stories/sampleLibrary';
import { BulkEditor } from './BulkEditor';

const meta = {
  component: BulkEditor,
  args: { items: sampleItems.slice(0, 3), onClose: fn(), onDeleted: fn() },
} satisfies Meta<typeof BulkEditor>;
export default meta;
type Story = StoryObj<typeof meta>;

/** Reads the selected books from the library, as the app does, so edits show (type a tag or creator and Remove). */
function Live(args: Parameters<typeof BulkEditor>[0]) {
  const { library } = useLibrary();
  const items = args.items.map((item) => library.items[item.id]).filter((item) => item !== undefined);
  return <BulkEditor {...args} items={items} />;
}

export const ThreeBooks: Story = { render: (args) => <Live {...args} /> };
