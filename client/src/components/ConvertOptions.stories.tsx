import type { Meta, StoryObj } from '@storybook/react-vite';
import { fn } from 'storybook/test';
import { OPTIMIZE_FIELDS } from '@nexlibris/crosspoint-tools/xteink/options';
import { PDF_FIELDS } from '@nexlibris/tools/formats/convert/pdf/options';
import { ConvertOptions, optionDefaults } from './ConvertOptions';

/** A conversion's options, as the convert dialogs ask for them. */
const meta = {
  component: ConvertOptions,
  args: { fields: OPTIMIZE_FIELDS, values: optionDefaults(OPTIMIZE_FIELDS), onChange: fn() },
} satisfies Meta<typeof ConvertOptions>;
export default meta;
type Story = StoryObj<typeof meta>;

/** The CrossPoint optimizer's options, at their defaults. */
export const Optimizer: Story = {};

/** EPUB to PDF's options: the page size, then checkboxes for headers and numbers. */
export const Pdf: Story = {
  args: { fields: PDF_FIELDS, values: optionDefaults(PDF_FIELDS) },
};
