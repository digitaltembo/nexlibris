import type { Meta, StoryObj } from '@storybook/react-vite';
import { useLayoutEffect, useState } from 'react';
import { fn } from 'storybook/test';
import { availableFields, DEFAULT_COLUMNS } from '../library/columns';
import type { Sort } from '@nexlibris/common';
import { sampleItems } from '../stories/sampleLibrary';
import { applyAppearance, type Appearance } from '../styles/appearance';
import { SettingsDialog, type SettingsTab, type View } from './SettingsDialog';

const fields = availableFields(sampleItems);

const meta = {
  component: SettingsDialog,
  args: {
    asked: { tab: 'appearance' },
    accounts: false,
    view: 'grid',
    onView: fn(),
    appearance: 'system',
    onAppearance: fn(),
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

function LiveSettings({ initialView, initialTab = 'appearance' }: { initialView: View; initialTab?: SettingsTab }) {
  const [view, setView] = useState<View>(initialView);
  const [asked] = useState({ tab: initialTab });
  // Picking light or dark here turns the story so, until the story is left.
  const [appearance, setAppearance] = useState<Appearance>('system');
  useLayoutEffect(() => {
    applyAppearance(appearance);
    return () => applyAppearance('system');
  }, [appearance]);
  const [sort, setSort] = useState<Sort>({ key: 'title', desc: false });
  const [columns, setColumns] = useState<string[]>(DEFAULT_COLUMNS);
  return (
    <SettingsDialog
      asked={asked}
      accounts={false}
      view={view}
      onView={setView}
      appearance={appearance}
      onAppearance={setAppearance}
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
export const Bookshelf: Story = { render: () => <LiveSettings initialView="bookshelf.shelf" /> };
export const Graph: Story = { render: () => <LiveSettings initialView="graph.force" /> };
export const Filesystem: Story = { render: () => <LiveSettings initialView="grid" initialTab="folder" /> };
export const Backup: Story = { render: () => <LiveSettings initialView="grid" initialTab="backup" /> };
export const Categories: Story = { render: () => <LiveSettings initialView="grid" initialTab="categories" /> };
export const Connections: Story = { render: () => <LiveSettings initialView="grid" initialTab="connections" /> };
