import type { Meta, StoryObj } from '@storybook/react-vite';
import { mergeTags } from '@nexlibris/common';
import { useState } from 'react';
import { fn } from 'storybook/test';
import { TagEditor } from './TagEditor';

const meta = {
  component: TagEditor,
  args: { tags: ['Science Fiction', 'Classic'], onAdd: fn(), onRemove: fn() },
} satisfies Meta<typeof TagEditor>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Empty: Story = { args: { tags: [] } };

function LiveTags() {
  const [tags, setTags] = useState(['Science Fiction', 'Classic']);
  return (
    <TagEditor
      tags={tags}
      onAdd={(added) => setTags((current) => mergeTags(current, added))}
      onRemove={(tag) => setTags((current) => current.filter((t) => t !== tag))}
    />
  );
}

/** Adding and removing change the tags shown, as in the app. */
export const Live: Story = { render: () => <LiveTags /> };
