import type { Meta, StoryObj } from '@storybook/react-vite';
import { fn } from 'storybook/test';
import { AppMenu } from './AppMenu';

const meta = {
  component: AppMenu,
  args: {
    onClose: fn(),
    entries: [
      { label: 'Import files…', onSelect: fn() },
      { label: 'New item', onSelect: fn() },
      { label: 'Add by ISBN…', onSelect: fn() },
      'separator',
      { label: 'Select items', onSelect: fn() },
      'separator',
      { label: 'Connections…', onSelect: fn() },
      { label: 'Sync…', onSelect: fn() },
      { label: 'Backup…', onSelect: fn() },
      'separator',
      { label: 'Settings…', onSelect: fn() },
    ],
  },
} satisfies Meta<typeof AppMenu>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

/** While an import runs. */
export const Importing: Story = {
  args: { entries: [{ label: 'Importing 3/12…', onSelect: fn(), disabled: true }, { label: 'New item', onSelect: fn() }] },
};
