import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { QueryInput } from './QueryInput';

function Live({ initial }: { initial: string }) {
  const [value, setValue] = useState(initial);
  return <QueryInput value={value} onChange={setValue} aria-label="Search" />;
}

const meta = { component: Live, args: { initial: '' } } satisfies Meta<typeof Live>;
export default meta;
type Story = StoryObj<typeof meta>;

/** Empty, with an example of the syntax. */
export const Empty: Story = {};

/** A field and a word, as a connection's catalog search: how many of the sample library's books match. */
export const FieldAndWord: Story = { args: { initial: 'tag:Classics austen' } };
