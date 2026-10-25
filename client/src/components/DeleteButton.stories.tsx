import type { Meta, StoryObj } from '@storybook/react-vite';
import { fn } from 'storybook/test';
import { DeleteButton } from './DeleteButton';

const meta = { component: DeleteButton, args: { onDelete: fn() } } satisfies Meta<typeof DeleteButton>;
export default meta;
type Story = StoryObj<typeof meta>;

/** Asks for confirmation in place before calling `onDelete`. */
export const Default: Story = {};

export const Several: Story = { args: { label: 'Delete 3 items' } };
