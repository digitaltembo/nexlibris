import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { fn } from 'storybook/test';
import { clickItem, NO_SELECTION } from '../../library/selection';
import { sampleItems } from '../../stories/sampleLibrary';
import { ForceGraph } from './ForceGraph';

const meta = {
  title: 'Plugins/Graph',
  component: ForceGraph,
  parameters: { layout: 'fullscreen' },
  args: { items: sampleItems, selection: new Set(), onActivate: fn(), onLongPress: fn() },
} satisfies Meta<typeof ForceGraph>;
export default meta;
type Story = StoryObj<typeof meta>;

/** Hover a node to light up its links; drag to turn the graph. Switch the OS to dark mode for the night sky. */
export const Default: Story = {};

/** A selected book is larger, in tomato. */
export const OneSelected: Story = { args: { selection: new Set([sampleItems[0]!.id]) } };

function SelectableGraph() {
  const [state, setState] = useState(NO_SELECTION);
  const order = sampleItems.map((i) => i.id);
  return (
    <ForceGraph
      items={sampleItems}
      selection={state.selection}
      onActivate={(id, keys) => setState(clickItem(state, id, order, keys))}
      onLongPress={() => {}}
    />
  );
}

/** Click a book to fly to it and select it; Cmd/Ctrl- or Shift-click for more. Click an author or tag to zoom to its books. */
export const Selectable: Story = { render: () => <SelectableGraph /> };
