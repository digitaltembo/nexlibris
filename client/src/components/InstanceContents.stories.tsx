import type { Meta, StoryObj } from '@storybook/react-vite';
import { useEffect, useState } from 'react';
import { fn } from 'storybook/test';
import { useLibrary } from '../library/LibraryContext';
import { sampleItems } from '../stories/sampleLibrary';
import { addInstances } from '../sync/instances';
import { InstanceContents } from './InstanceContents';

/** "On it…" for an instance that syncs with this one as its hub: the books it offered here, to ask for. */
function Offered(props: { onDownload(): void; onDone(): void; onClose(): void }) {
  const { backend, apply, library } = useLibrary();
  const [ready, setReady] = useState(false);
  useEffect(() => {
    void (async () => {
      await apply(addInstances(await backend.getLibrary(), [{ origin: 'phone-origin', name: 'Pixel 8' }]));
      const offered = sampleItems.slice(0, 3).map((item) => ({ ...item, id: `${item.id}-phone` }));
      await backend.writeLocalState('sync-offers', {
        peers: { 'phone-origin': { items: offered, requested: [offered[1]!.id], at: '2026-10-18T20:00:00.000Z' } },
      });
      setReady(true);
    })();
  }, [backend, apply]);
  const device = library.devices?.['phone-origin'];
  return ready && device ? <InstanceContents device={device} {...props} /> : null;
}

const meta = { component: Offered, args: { onDownload: fn(), onDone: fn(), onClose: fn() } } satisfies Meta<typeof Offered>;
export default meta;
type Story = StoryObj<typeof meta>;

/** A phone's books offered to this computer at its last sync, one already asked for. */
export const OfferedBooks: Story = {};
