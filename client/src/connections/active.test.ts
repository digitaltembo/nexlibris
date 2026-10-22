import { createDevice, MemoryStorage, StoredLibraryBackend } from '@nexlibris/common';
import { expect, it, vi } from 'vitest';
import { connectionStatus, recheckConnections, setConnectionActive } from './active';
import { INSTANCE_TYPE } from '../sync/instances';
import { opdsExport, opdsServed } from './opds';
import { folderType } from './folder';

let account: { id: string; name: string } | undefined;
vi.mock('../library/account', async (original) => ({
  ...(await original<typeof import('../library/account')>()),
  serverSession: async () => ({ name: 'Cloud', signup: false, ...(account && { account }) }),
}));

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

it('keeps a served feed active only while signed in to a server', async () => {
  const feed = createDevice({ name: 'Feed', type: opdsServed.id });
  account = undefined;
  await recheckConnections([feed]);
  expect(connectionStatus(feed)).toEqual({ active: false, reason: 'Sign in to a nexlibris server (Account…) to serve it', manual: false });
  account = { id: 'a', name: 'ada' };
  await recheckConnections([feed]);
  expect(connectionStatus(feed)).toEqual({ active: true, manual: false });
});
