import type { Meta, StoryObj } from '@storybook/react-vite';
import { pairingText } from '@nexlibris/common';
import { QrCode } from './QrCode';

const meta = { component: QrCode } satisfies Meta<typeof QrCode>;
export default meta;
type Story = StoryObj<typeof meta>;

/** A sync pairing code, as the desktop shows it. */
export const Pairing: Story = {
  args: { text: pairingText('http://192.168.0.11:47811', 'K3Q9-TX2M'), label: 'Pairing code K3Q9-TX2M' },
};
