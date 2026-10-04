import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { fn } from 'storybook/test';
import { availableFields, DEFAULT_COLUMNS } from '../library/columns';
import type { Sort } from '../library/search';
import { sampleItems } from '../stories/sampleLibrary';
import { SettingsDialog, type View } from './SettingsDialog';

const fields = availableFields(sampleItems);

const meta = {
  component: SettingsDialog,
  args: {
    view: 'grid',
    onView: fn(),
    sort: { key: 'title', desc: false },
    onSort: fn(),
    columns: DEFAULT_COLUMNS,
    fields,
    onColumns: fn(),
    onClose: fn(),
  },
} satisfies Meta<typeof SettingsDialog>;
export default meta;
type Story = StoryObj<typeof meta>;

function LiveSettings({ initialView }: { initialView: View }) {
  const [view, setView] = useState<View>(initialView);
  const [sort, setSort] = useState<Sort>({ key: 'title', desc: false });
  const [columns, setColumns] = useState<string[]>(DEFAULT_COLUMNS);
  return (
    <SettingsDialog
      view={view}
      onView={setView}
      sort={sort}
      onSort={setSort}
      columns={columns}
      fields={fields}
      onColumns={setColumns}
      onClose={() => undefined}
    />
  );
}

export const Grid: Story = { render: () => <LiveSettings initialView="grid" /> };
export const List: Story = { render: () => <LiveSettings initialView="list" /> };
