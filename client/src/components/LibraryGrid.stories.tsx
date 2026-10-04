import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { fn } from 'storybook/test';
import { clickItem, NO_SELECTION, toggleItem } from '../library/selection';
import { sampleItems } from '../stories/sampleLibrary';
import { LibraryGrid } from './LibraryGrid';

const meta = {
  component: LibraryGrid,
  args: { items: sampleItems, selection: new Set(), onActivate: fn(), onLongPress: fn() },
} satisfies Meta<typeof LibraryGrid>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

/** One book selected, as when its preview is open. */
export const OneSelected: Story = { args: { selection: new Set([sampleItems[1]!.id]) } };

export const SeveralSelected: Story = {
  args: { selection: new Set([sampleItems[0]!.id, sampleItems[2]!.id, sampleItems[3]!.id]) },
};

function SelectableGrid() {
  const [state, setState] = useState(NO_SELECTION);
  const order = sampleItems.map((i) => i.id);
  return (
    <LibraryGrid
      items={sampleItems}
      selection={state.selection}
      onActivate={(id, keys) => setState(clickItem(state, id, order, keys))}
      onLongPress={(id) => setState(toggleItem(state, id))}
    />
  );
}

/** Click, Cmd/Ctrl-click, Shift-click, or long-press with touch. */
export const Selectable: Story = { render: () => <SelectableGrid /> };
