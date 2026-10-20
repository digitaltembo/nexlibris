import type { Meta, StoryObj } from '@storybook/react-vite';
import { fn } from 'storybook/test';
import { sampleItems } from '../stories/sampleLibrary';
import { SendTo } from './SendTo';

const meta = { component: SendTo, args: { items: [sampleItems[0]!], onClose: fn() } } satisfies Meta<typeof SendTo>;
export default meta;
type Story = StoryObj<typeof meta>;

/** One book, to the sample library's X4 (Send connects to it, so needs it on the network) or its catalog (Add). */
export const OneBook: Story = {};

/** Several books, from Bulk edit. */
export const SeveralBooks: Story = { args: { items: sampleItems.slice(0, 3) } };
