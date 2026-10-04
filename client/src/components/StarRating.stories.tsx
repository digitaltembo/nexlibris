import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { StarRating } from './StarRating';

const meta = { component: StarRating } satisfies Meta<typeof StarRating>;
export default meta;
type Story = StoryObj<typeof meta>;

export const ReadOnly: Story = { args: { value: 4 } };

export const Unrated: Story = { args: { value: undefined } };

function EditableRating() {
  const [value, setValue] = useState<number | undefined>(3);
  return <StarRating value={value} onChange={setValue} />;
}

/** Click a star to rate; click the current rating to clear it. */
export const Editable: Story = { args: { value: 3 }, render: () => <EditableRating /> };
