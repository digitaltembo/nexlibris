import type { Meta, StoryObj } from '@storybook/react-vite';
import { fn } from 'storybook/test';
import { sampleItems } from '../stories/sampleLibrary';
import { TextResults } from './TextResults';

/** The sample library has made-up text indexed for Dune and Emma. */
const meta = {
  component: TextResults,
  args: { query: 'desert', items: sampleItems, onRead: fn(), onOpenItem: fn() },
} satisfies Meta<typeof TextResults>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Found: Story = {};
/** A word in both books. */
export const AcrossBooks: Story = { args: { query: 'across' } };
export const NothingFound: Story = { args: { query: 'harpoon' } };
