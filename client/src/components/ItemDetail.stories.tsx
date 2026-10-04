import type { Meta, StoryObj } from '@storybook/react-vite';
import { fn } from 'storybook/test';
import { LiveItem } from '../stories/LiveItem';
import { sampleItems } from '../stories/sampleLibrary';
import { ItemDetail } from './ItemDetail';

const meta = {
  component: ItemDetail,
  parameters: { layout: 'fullscreen' },
  args: { item: sampleItems[0]!, onClose: fn(), onSelectTag: fn(), onRead: fn() },
  // The item as it is in the story's library, so "Edit" and the rating change what's shown.
  render: (args) => <LiveItem id={args.item.id}>{(item) => <ItemDetail key={item.id} {...args} item={item} />}</LiveItem>,
} satisfies Meta<typeof ItemDetail>;
export default meta;
type Story = StoryObj<typeof meta>;

/** Series, identifiers, two files and a rating. */
export const Dune: Story = {};

/** A description, shown with `RichText`. */
export const WithDescription: Story = { args: { item: sampleItems.find((item) => item.title === 'Emma')! } };

/** No cover and no files. */
export const Sparse: Story = { args: { item: sampleItems.find((item) => item.files.length === 0)! } };
