import type { Meta, StoryObj } from '@storybook/react-vite';
import { fn } from 'storybook/test';
import { xteinkConverter } from '../formats/convert/converters';
import { OPTIMIZE_FIELDS } from '../formats/convert/xteink/options';
import { ConvertOptionsDialog } from './ConvertOptions';

/** Asked for before converting a file with a converter that has options. */
const meta = {
  component: ConvertOptionsDialog,
  args: {
    converter: { ...xteinkConverter('X4'), options: OPTIMIZE_FIELDS },
    title: 'Convert to X4 EPUB',
    what: 'Dune - Frank Herbert.epub',
    onConvert: fn(),
    onClose: fn(),
  },
} satisfies Meta<typeof ConvertOptionsDialog>;
export default meta;
type Story = StoryObj<typeof meta>;

/** The CrossPoint optimizer's options, at their defaults. */
export const Optimizer: Story = {};
