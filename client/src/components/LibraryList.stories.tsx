import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { fn } from 'storybook/test';
import { availableFields, DEFAULT_COLUMNS, visibleColumns } from '../library/columns';
import { sortItems, type Sort } from '@nexlibris/common';
import { sampleItems } from '../stories/sampleLibrary';
import { LibraryList } from './LibraryList';

const columns = visibleColumns(DEFAULT_COLUMNS, availableFields(sampleItems));

const meta = {
  component: LibraryList,
  args: {
    items: sampleItems,
    selection: new Set(),
    onActivate: fn(),
    onLongPress: fn(),
    columns,
    sort: { key: 'title', desc: false },
    onSort: fn(),
  },
} satisfies Meta<typeof LibraryList>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const SeveralSelected: Story = { args: { selection: new Set([sampleItems[0]!.id, sampleItems[2]!.id]) } };

export const FewColumns: Story = { args: { columns: ['creators', 'rating'] } };

/** What title and author sort by: Dune's stored author sort, and the rest worked out (shown quieter). */
export const SortColumns: Story = { args: { columns: ['creators', 'titleSort', 'authorSort'], sort: { key: 'author', desc: false } } };

/** Size (MB), as Calibre's column: each book's largest file (the header shows the sort; the app sorts the rows). */
export const SizeColumn: Story = { args: { columns: ['creators', 'formats', 'size'], sort: { key: 'size', desc: true } } };

function SortableList() {
  const [sort, setSort] = useState<Sort>({ key: 'title', desc: false });
  return (
    <LibraryList
      items={sortItems(sampleItems, sort)}
      selection={new Set()}
      onActivate={() => undefined}
      onLongPress={() => undefined}
      columns={columns}
      sort={sort}
      onSort={setSort}
    />
  );
}

/** Click a column heading to sort by it. */
export const Sortable: Story = { render: () => <SortableList /> };
