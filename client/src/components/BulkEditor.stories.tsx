import type { Meta, StoryObj } from '@storybook/react-vite';
import { fn } from 'storybook/test';
import { sampleItems } from '../stories/sampleLibrary';
import { BulkEditor } from './BulkEditor';

const meta = {
  component: BulkEditor,
  args: { items: sampleItems.slice(0, 3), onClose: fn(), onDeleted: fn() },
} satisfies Meta<typeof BulkEditor>;
export default meta;
type Story = StoryObj<typeof meta>;

export const ThreeBooks: Story = {};
