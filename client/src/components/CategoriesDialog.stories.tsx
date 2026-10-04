import type { Meta, StoryObj } from '@storybook/react-vite';
import { fn } from 'storybook/test';
import { CategoriesDialog } from './CategoriesDialog';

/** Edits the sample library's categories (it has one, Moods). */
const meta = {
  component: CategoriesDialog,
  args: { onClose: fn() },
} satisfies Meta<typeof CategoriesDialog>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
