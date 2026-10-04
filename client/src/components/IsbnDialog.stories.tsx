import type { Meta, StoryObj } from '@storybook/react-vite';
import { fn } from 'storybook/test';
import { IsbnDialog } from './IsbnDialog';

/** Looking an ISBN up calls Open Library, and scanning asks for the camera. */
const meta = { component: IsbnDialog, args: { onClose: fn(), onOpen: fn() } } satisfies Meta<typeof IsbnDialog>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
