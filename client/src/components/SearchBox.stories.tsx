import type { Meta, StoryObj } from '@storybook/react-vite';
import { fn } from 'storybook/test';
import { SearchBox } from './SearchBox';

const meta = {
  component: SearchBox,
  args: { value: '', placeholder: 'Search 5 items…', onOpen: fn(), onClear: fn(), filterCount: 0, onFilters: fn() },
} satisfies Meta<typeof SearchBox>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Empty: Story = {};
/** After a search: what was searched for, with a button to clear it. */
export const Searched: Story = { args: { value: 'author:"Frank Herbert" dune' } };
/** A search of the text inside books, marked as such. */
export const InsideBooks: Story = { args: { value: 'harpoon', inText: true } };
export const WithFilters: Story = { args: { value: 'dune', filterCount: 2 } };
