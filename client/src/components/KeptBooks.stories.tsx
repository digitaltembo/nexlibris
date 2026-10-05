import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { fn } from 'storybook/test';
import { KeptBooks } from './KeptBooks';

const meta = { component: KeptBooks, args: { name: 'the device', query: 'has:file', onChange: fn() } } satisfies Meta<typeof KeptBooks>;
export default meta;
type Story = StoryObj<typeof meta>;

function Chooser(args: Parameters<typeof KeptBooks>[0]) {
  const [query, setQuery] = useState(args.query);
  return <KeptBooks {...args} query={query} onChange={setQuery} />;
}

/** Before a device pairs: every book's files, until Choose books… narrows it (the code then carries the choice). */
export const EveryBook: Story = { render: (args) => <Chooser {...args} /> };

/** A paired phone that gets only some books. */
export const SomeBooks: Story = { args: { name: 'Pixel', query: 'tag:Classic' }, render: (args) => <Chooser {...args} /> };

/** A paired phone where three books were deleted: they stay here, kept off it, until brought back. */
export const DeletedThere: Story = { args: { name: 'Pixel', query: 'tag:Classic', excluded: 3, onBringBack: fn() }, render: (args) => <Chooser {...args} /> };
