import type { Meta, StoryObj } from '@storybook/react-vite';
import { fn } from 'storybook/test';
import { connectionType } from '../connections';
import { checkSend } from '../devices/send';
import { useLibrary } from '../library/LibraryContext';
import { sampleDevice, sampleItems } from '../stories/sampleLibrary';
import { Modal } from './Modal';
import { SendCheckStep } from './SendCheck';

/** Sending the sample books to the X4: those without an X4 EPUB, and a file whose details are behind the library's. */
function Check({ onContinue, onCancel }: { onContinue(): void; onCancel(): void }) {
  const { library } = useLibrary();
  const device = library.devices?.[sampleDevice.id] ?? sampleDevice;
  const type = connectionType(device.type)!;
  const items = sampleItems.map((item) => library.items[item.id] ?? item);
  const check = checkSend(library, device, type, items);
  // As if Dune's EPUB was written before its details last changed.
  const dune = items[0]!;
  const behind = dune.files.find((f) => f.format === 'epub');
  if (behind) check.behind.push({ item: dune, file: behind, changes: [] });
  return (
    <Modal title={`Send to ${device.name}`} onClose={onCancel}>
      <SendCheckStep device={device} type={type} check={check} onContinue={onContinue} onCancel={onCancel} />
    </Modal>
  );
}

const meta = { component: Check, args: { onContinue: fn(), onCancel: fn() } } satisfies Meta<typeof Check>;
export default meta;
type Story = StoryObj<typeof meta>;

/** Asked before sending: convert to the reader's optimized EPUB (with the converter's options), update files, or send as they are. */
export const ConvertOrUpdate: Story = {};
