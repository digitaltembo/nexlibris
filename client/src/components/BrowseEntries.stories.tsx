import type { Category } from '@nexlibris/common';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { fn } from 'storybook/test';
import { browse } from '../library/browse';
import { sampleCategory, sampleItems } from '../stories/sampleLibrary';
import { BrowseEntries } from './BrowseEntries';

const entries = (path: string[], categories: Category[] = [sampleCategory]) => {
  const view = browse(sampleItems, path, categories);
  return view.kind === 'entries' ? view.entries : [];
};

const meta = {
  component: BrowseEntries,
  args: { entries: entries([]), layout: 'grid', onOpen: fn() },
} satisfies Meta<typeof BrowseEntries>;
export default meta;
type Story = StoryObj<typeof meta>;

/** The Library's categories, each shown by one of its books' covers. */
export const Library: Story = {};

export const LibraryAsList: Story = { args: { layout: 'list' } };

export const Authors: Story = { args: { entries: entries(['authors']) } };

/** A category of the user's own: its entries. */
export const CustomCategory: Story = { args: { entries: entries(['category', sampleCategory.id]) } };

/** An entry with no books has no cover to show, so it shows its name. */
export const NoBooks: Story = {
  args: { entries: entries(['category', 'none'], [{ ...sampleCategory, id: 'none', entries: [{ label: 'Poetry', query: 'tag:Poetry' }, ...sampleCategory.entries] }]) },
};
