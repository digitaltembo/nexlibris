import { createDevice, MemoryStorage, StoredLibraryBackend } from '@nexlibris/common';
import { expect, it, vi } from 'vitest';
import { connectionStatus, recheckConnections, setConnectionActive } from './active';
import { INSTANCE_TYPE } from '../sync/instances';
import { opdsExport } from './opds';
import { folderType } from './folder';

vi.mock('../library/savedFolders', async (original) => ({
  ...(await original<typeof import('../library/savedFolders')>()),
  canUseFolders: () => true,
  savedFolder: async () => undefined,
}));

it('keeps the export always active, an instance active only once activated here, and a folder by whether it has one', async () => {
  const backend = new StoredLibraryBackend(new MemoryStorage(), 'Mine');
  const exportDevice = createDevice({ name: 'Catalog', type: opdsExport.id });
  const twin = createDevice({ name: 'Phone', type: INSTANCE_TYPE });
  const folder = createDevice({ name: 'USB', type: folderType.id });

  expect(connectionStatus(exportDevice)).toEqual({ active: true, manual: false });
  expect(connectionStatus(twin)).toMatchObject({ active: false, manual: true });
  await setConnectionActive(backend, twin.id, true);
  expect(connectionStatus(twin).active).toBe(true);
  expect(await backend.readLocalState('active-connections')).toEqual([twin.id]);
  await setConnectionActive(backend, twin.id, false);
  expect(connectionStatus(twin).active).toBe(false);

  expect(connectionStatus(folder).reason).toBe('Checking…');
  await recheckConnections([folder]);
  expect(connectionStatus(folder)).toEqual({ active: false, reason: 'No folder chosen on this device', manual: false });
});
