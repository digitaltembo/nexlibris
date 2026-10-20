import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { fn } from 'storybook/test';
import { searchFields } from '../library/suggest';
import { sampleItems } from '../stories/sampleLibrary';
import { SearchBox } from './SearchBox';
import { SearchDialog, type SearchMode } from './SearchDialog';

const fields = searchFields(sampleItems);

const meta = {
  component: SearchDialog,
  args: {
    query: '',
    mode: 'books',
    items: sampleItems,
    fields,
    ratings: {},
    onSearch: fn(),
    onClose: fn(),
    onOpenItem: fn(),
    onRead: fn(),
  },
} satisfies Meta<typeof SearchDialog>;
export default meta;
type Story = StoryObj<typeof meta>;

/** Before typing: fields to search by, and recent searches. */
export const Empty: Story = {};

/** Completing a tag, with the books found so far. */
export const CompletingTag: Story = { args: { query: 'tag:sci' } };

/** Fields and words together, as the search box takes them. */
export const FieldsAndWords: Story = { args: { query: 'rating:4+ format:epub herbert' } };

/** Searching the text inside books (the sample library has made-up text for Dune and Emma): passages, never mixed with books. */
export const InsideBooks: Story = { args: { mode: 'text', query: 'desert' } };

/** The bar and the dialog together: click the bar, search, press Enter. */
function BarAndDialog() {
  const [query, setQuery] = useState('');
  const [mode, setMode] = useState<SearchMode>('books');
  const [open, setOpen] = useState(false);
  return (
    <>
      <SearchBox
        value={query}
        inText={mode === 'text'}
        placeholder="Search 5 items…"
        onOpen={() => setOpen(true)}
        onClear={() => setQuery('')}
      />
      {open && (
        <SearchDialog
          query={query}
          mode={mode}
          items={sampleItems}
          fields={fields}
          ratings={{}}
          onSearch={(q, m) => {
            setQuery(q);
            setMode(m);
            setOpen(false);
          }}
          onClose={() => setOpen(false)}
          onOpenItem={() => undefined}
          onRead={() => undefined}
        />
      )}
    </>
  );
}

export const InTheBar: Story = { render: () => <BarAndDialog /> };
