import type { Meta, StoryObj } from '@storybook/react-vite';
import { fn } from 'storybook/test';
import { sampleItems } from '../stories/sampleLibrary';
import { AddTo } from './AddTo';

const meta = { component: AddTo, args: { items: [sampleItems[0]!], onClose: fn() } } satisfies Meta<typeof AddTo>;
export default meta;
type Story = StoryObj<typeof meta>;

/** Dune, already in the X4's catalog (Remove takes it out), and not in the Shelf catalog's (Add). */
export const OneBook: Story = {};

/** Several books, some in a catalog already. */
export const SeveralBooks: Story = { args: { items: sampleItems.slice(0, 3) } };

/** Just one file of a book, from its "⋯" menu: the catalog then holds that file of it. */
export const OneFile: Story = { args: { items: [sampleItems[0]!], file: sampleItems[0]!.files[0]! } };
