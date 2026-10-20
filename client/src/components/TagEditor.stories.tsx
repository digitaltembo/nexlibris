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

/** Adding and removing change the tags shown, as in the app; typing completes the sample library's tags (try "fa"). */
export const Live: Story = { render: () => <LiveTags /> };

function LiveFormats() {
  const [formats, setFormats] = useState(['epub', 'pdf']);
  return (
    <TagEditor
      tags={formats}
      candidates={['epub', 'x4.epub', 'x3.epub', 'pdf', 'cbz', 'cbr', 'azw3', 'mobi', 'txt']}
      only
      noun="format"
      onAdd={(added) => setFormats((current) => [...new Set([...current, ...added])])}
      onRemove={(format) => setFormats((current) => current.filter((f) => f !== format))}
    />
  );
}

/** As a connection's "Only specific formats": completes from the formats nexlibris knows, and takes nothing else. */
export const Formats: Story = { render: () => <LiveFormats /> };
