import type { Meta, StoryObj } from '@storybook/react-vite';
import { fn } from 'storybook/test';
import { sampleItems } from '../stories/sampleLibrary';
import { ConvertDialog } from './ConvertDialog';

/** Converting a book: from one of its files, to any format the conversions reach, with that conversion's options. */
const meta = {
  component: ConvertDialog,
  args: { item: sampleItems[0]!, onClose: fn() },
} satisfies Meta<typeof ConvertDialog>;
export default meta;
type Story = StoryObj<typeof meta>;

/** Dune, with an EPUB and an X4 EPUB: no options until a format with some is picked (PDF, an X3 EPUB). */
export const Default: Story = {};

/** Emma, with an EPUB and a PDF. */
export const WithPdf: Story = { args: { item: sampleItems[3]! } };

/** A book whose only file is a MOBI: everything but EPUB is made by way of EPUB, which the dialog warns of. */
export const Indirect: Story = {
  args: { item: { ...sampleItems[2]!, files: [{ hash: 'mobi'.padEnd(64, '0'), size: 512_000, format: 'mobi', name: 'Piranesi.mobi' }] } },
};
