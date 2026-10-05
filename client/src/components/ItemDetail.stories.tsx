import { createItem } from '@nexlibris/common';
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

/** A date before AD 1, shown with its era ("570 BC"). Not in the story's library, so editing it does nothing. */
export const AncientWork: Story = {
  args: {
    item: createItem({
      title: 'Sappho: One Hundred Lyrics',
      creators: [{ name: 'Sappho', role: 'aut' }, { name: 'Bliss Carman', role: 'trl' }],
      metadata: { originallyPublished: '-0570', published: '1904', language: 'eng' },
    }),
  },
  render: (args) => <ItemDetail {...args} />,
};
