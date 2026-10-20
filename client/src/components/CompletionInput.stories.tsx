import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { fn } from 'storybook/test';
import { CompletionInput } from './CompletionInput';

const meta = {
  component: CompletionInput,
  args: {
    value: '',
    onChange: fn(),
    candidates: ['Science Fiction', 'Fantasy', 'Classic', 'Fairy Tales', 'Hard Science', 'Romance'],
    placeholder: 'Tags, comma-separated…',
    'aria-label': 'Tags',
  },
} satisfies Meta<typeof CompletionInput>;
export default meta;
type Story = StoryObj<typeof meta>;

function Live(args: Parameters<typeof CompletionInput>[0]) {
  const [value, setValue] = useState(args.value);
  return <CompletionInput {...args} value={value} onChange={setValue} />;
}

/** Type "f" or "sci" to see completions; arrows and Enter or a click pick one. */
export const Default: Story = { render: (args) => <Live {...args} /> };

/** Tags a book already has aren't offered. */
export const Excluding: Story = { args: { exclude: ['Fantasy'] }, render: (args) => <Live {...args} /> };
