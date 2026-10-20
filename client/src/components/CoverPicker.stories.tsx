import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import type { NewCover } from '../library/editCover';
import { sampleItems } from '../stories/sampleLibrary';
import { CoverPicker } from './CoverPicker';

const meta = {
  component: CoverPicker,
  args: { item: sampleItems[0]!, cover: undefined, onChange: () => {} },
  // Keeps the chosen cover, as the editor does until it saves.
  render: function Render(args) {
    const [cover, setCover] = useState<NewCover>();
    return (
      <div style={{ width: 96 }}>
        <CoverPicker {...args} cover={cover} onChange={setCover} />
      </div>
    );
  },
} satisfies Meta<typeof CoverPicker>;
export default meta;
type Story = StoryObj<typeof meta>;

/** Dune, with an ISBN, as in the editor's header. "Find on Open Library" asks the real Open Library. */
export const Default: Story = {};

/** No cover yet: try Generate. An Open Library that knows nothing of the book. */
export const NothingFound: Story = {
  args: { item: sampleItems.find((item) => !item.cover)!, fetchFn: (async () => Response.json({ docs: [] })) as typeof fetch },
};

/** An Open Library that can't be reached. */
export const Offline: Story = {
  args: {
    fetchFn: (async () => {
      throw new TypeError('Failed to fetch');
    }) as typeof fetch,
  },
};
