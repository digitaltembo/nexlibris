import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { fn } from 'storybook/test';
import { clickItem, NO_SELECTION, toggleItem } from '../../library/selection';
import { sampleItems } from '../../stories/sampleLibrary';
import { Bookshelf } from './Bookshelf';

const meta = {
  title: 'Plugins/Bookshelf',
  component: Bookshelf,
  args: { items: sampleItems, selection: new Set(), onActivate: fn(), onLongPress: fn() },
} satisfies Meta<typeof Bookshelf>;
export default meta;
type Story = StoryObj<typeof meta>;

/** Hover a book to see it lean out. */
export const Default: Story = {};

/** A selected book leans out and stays out. */
export const OneSelected: Story = { args: { selection: new Set([sampleItems[1]!.id]) } };

/** Enough books for several shelves. */
export const Shelves: Story = {
  args: {
    items: Array.from({ length: 6 }, (_, copy) => sampleItems.map((item) => ({ ...item, id: `${item.id}-${copy}` }))).flat(),
  },
};

function SelectableShelf() {
  const [state, setState] = useState(NO_SELECTION);
  const order = sampleItems.map((i) => i.id);
  return (
    <Bookshelf
      items={sampleItems}
      selection={state.selection}
      onActivate={(id, keys) => setState(clickItem(state, id, order, keys))}
      onLongPress={(id) => setState(toggleItem(state, id))}
    />
  );
}

/** Click, Cmd/Ctrl-click, Shift-click, or long-press with touch. */
export const Selectable: Story = { render: () => <SelectableShelf /> };
