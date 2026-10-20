import type { Meta, StoryObj } from '@storybook/react-vite';
import { useEffect, useState } from 'react';
import { useLibrary } from '../library/LibraryContext';
import { sampleItems } from '../stories/sampleLibrary';
import { ConnectionBrowser } from './ConnectionBrowser';
import { addInstances } from '../sync/instances';

/** An instance that synced with this one as its hub, offering two books (one already asked for). */
function Offered() {
  const { backend, apply, library } = useLibrary();
  const [ready, setReady] = useState(false);
  useEffect(() => {
    void (async () => {
      await apply(addInstances(await backend.getLibrary(), [{ origin: 'phone-origin', name: 'Pixel 8' }]));
      const offered = sampleItems.slice(0, 2).map((item) => ({ ...item, id: `${item.id}-phone`, title: `${item.title} (phone’s copy)` }));
      await backend.writeLocalState('sync-offers', {
        peers: { 'phone-origin': { items: offered, requested: [offered[0]!.id], at: '2026-10-18T20:00:00.000Z' } },
      });
      setReady(true);
    })();
  }, [backend, apply]);
  const device = library.devices?.['phone-origin'];
  return ready && device ? <ConnectionBrowser device={device} /> : null;
}

const meta = { component: Offered } satisfies Meta<typeof Offered>;
export default meta;
type Story = StoryObj<typeof meta>;

/** In the Library, another instance's books as it offered them here: open one to ask for it (or stop asking). A reader or folder is read from it when opened. */
export const OfferedByAnInstance: Story = {};
