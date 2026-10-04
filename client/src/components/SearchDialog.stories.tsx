import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { fn } from 'storybook/test';
import { filterFields } from '../library/filters';
import { sampleItems } from '../stories/sampleLibrary';
import { SearchBox } from './SearchBox';
import { SearchDialog, type SearchMode } from './SearchDialog';

const fields = filterFields(sampleItems);

const meta = {
  component: SearchDialog,
  args: {
    query: '',
    mode: 'books',
    filterQuery: '',
    items: sampleItems,
    fields,
    ratings: {},
    onSearch: fn(),
    onClose: fn(),
    onFilterQuery: fn(),
    onEditFilters: fn(),
    onOpenItem: fn(),
    onRead: fn(),
  },
} satisfies Meta<typeof SearchDialog>;
export default meta;
type Story = StoryObj<typeof meta>;

/** Before typing: the filters, fields to search by, and recent searches. */
export const Empty: Story = {};

/** Completing a tag, with the books found so far. */
export const CompletingTag: Story = { args: { query: 'tag:sci' } };

/** With filters on, shown as chips that can be removed. */
export const WithFilters: Story = { args: { query: 'herbert', filterQuery: 'rating:4+ format:epub' } };

/** Searching the text inside books (the sample library has made-up text for Dune and Emma): passages, never mixed with books. */
export const InsideBooks: Story = { args: { mode: 'text', query: 'desert' } };

/** The bar and the dialog together: click the bar, search, press Enter. */
function BarAndDialog() {
  const [query, setQuery] = useState('');
  const [mode, setMode] = useState<SearchMode>('books');
  const [filterQuery, setFilterQuery] = useState('');
  const [open, setOpen] = useState(false);
  return (
    <>
      <SearchBox
        value={query}
        inText={mode === 'text'}
        placeholder="Search 5 items…"
        onOpen={() => setOpen(true)}
        onClear={() => setQuery('')}
        filterCount={filterQuery ? 1 : 0}
        onFilters={() => undefined}
      />
      {open && (
        <SearchDialog
          query={query}
          mode={mode}
          filterQuery={filterQuery}
          items={sampleItems}
          fields={fields}
          ratings={{}}
          onSearch={(q, m) => {
            setQuery(q);
            setMode(m);
            setOpen(false);
          }}
          onClose={() => setOpen(false)}
          onFilterQuery={setFilterQuery}
          onEditFilters={() => undefined}
          onOpenItem={() => undefined}
          onRead={() => undefined}
        />
      )}
    </>
  );
}

export const InTheBar: Story = { render: () => <BarAndDialog /> };
