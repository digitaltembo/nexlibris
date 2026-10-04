import type { Meta, StoryObj } from '@storybook/react-vite';
import { fn } from 'storybook/test';
import { sampleItems } from '../stories/sampleLibrary';
import { BulkConvertDialog } from './BulkConvertDialog';

const meta = {
  component: BulkConvertDialog,
  args: { items: sampleItems, onClose: fn() },
} satisfies Meta<typeof BulkConvertDialog>;
export default meta;
type Story = StoryObj<typeof meta>;

/** The sample books: some have EPUBs already, one a PDF, one no file. */
export const Default: Story = {};
