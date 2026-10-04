import type { Meta, StoryObj } from '@storybook/react-vite';
import { fn } from 'storybook/test';
import { BackupDialog } from './BackupDialog';

const meta = { component: BackupDialog, args: { onClose: fn() } } satisfies Meta<typeof BackupDialog>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
