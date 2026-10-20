import type { Meta, StoryObj } from '@storybook/react-vite';
import { fn } from 'storybook/test';
import { MenuButton } from './MenuButton';

const meta = {
  component: MenuButton,
  args: {
    label: 'Actions for Dune.epub',
    actions: [
      { label: 'Download', onSelect: fn() },
      { label: 'Convert to KEPUB', onSelect: fn() },
      { label: 'Convert to X4 EPUB…', onSelect: fn(), disabled: true },
      { label: 'Show in folder', onSelect: fn() },
      { label: 'Remove…', danger: true, onSelect: fn() },
    ],
  },
} satisfies Meta<typeof MenuButton>;
export default meta;
type Story = StoryObj<typeof meta>;

/** A file's actions, as in a book's details: one converting already, and the destructive one last. */
export const FileActions: Story = {};
