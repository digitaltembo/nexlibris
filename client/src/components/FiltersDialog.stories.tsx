import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { fn } from 'storybook/test';
import { filterItems } from '../library/search';
import { sampleItems } from '../stories/sampleLibrary';
import { FiltersDialog } from './FiltersDialog';

const count = (query: string) => filterItems(sampleItems, query).length;

const meta = {
  component: FiltersDialog,
  args: { title: 'Filters', query: '', onChange: fn(), onClose: fn(), items: sampleItems, count },
} satisfies Meta<typeof FiltersDialog>;
export default meta;
type Story = StoryObj<typeof meta>;

function LiveFilters({ initial, intro }: { initial: string; intro?: string }) {
  const [query, setQuery] = useState(initial);
  return (
    <FiltersDialog
      title="Filters"
      intro={intro}
      query={query}
      onChange={setQuery}
      onClose={() => undefined}
      items={sampleItems}
      count={count}
    />
  );
}

export const Empty: Story = { render: () => <LiveFilters initial="" /> };

export const WithRules: Story = { render: () => <LiveFilters initial='tag:"Science Fiction" rating>=4' /> };

/** As a device's rules, which say what goes on it. */
export const ForADevice: Story = {
  render: () => <LiveFilters initial="tag:Classic" intro="Books matching these rules go on the X4, as they change." />,
};
