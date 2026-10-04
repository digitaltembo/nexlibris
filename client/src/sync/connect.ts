import {
  createMessageClient,
  httpHubFiles,
  httpSend,
  readPairings,
  syncApiMeta,
  type FileHash,
  type HubFiles,
  type LibraryBackend,
  type Pairing,
  type SyncClient,
} from '@nexlibris/common';
import { inDesktopApp } from '../backends/desktopBridge';
import { BLUETOOTH_BASE, bluetoothLink, canSyncOverBluetooth, isBluetoothAddress, linkFetch } from './bluetooth';
import { canSyncThroughFolder, isFolderAddress, pairedFolder } from './folder';
import { fileFetched, hubFiles } from './files';
import { folderKeepRule } from './instances';
import { canSyncOverNetwork, hubClient, instanceName } from './hub';

/**
 * Reaching a paired hub however it's paired, from its address: over the network (`http…`), over
 * Bluetooth (`bluetooth:…`) or through a folder (`folder:…`). Connecting over Bluetooth may show
 * the browser's chooser, and a folder may need permission again: both need a click under way, so
 * they're only tried when `interactive`; otherwise only what's open already is used.
 */

export type Transport = 'network' | 'bluetooth' | 'folder';

export const transportOf = (address: string): Transport =>
  isBluetoothAddress(address) ? 'bluetooth' : isFolderAddress(address) ? 'folder' : 'network';

/** How a pairing is reached, in words, e.g. "over Bluetooth (Pixel 8)". */
export function describeAddress(address: string): string {
  switch (transportOf(address)) {
    case 'bluetooth':
      return `over Bluetooth (${address.slice(address.indexOf(':') + 1)})`;
    case 'folder':
      return `through the folder “${address.slice(address.indexOf(':') + 1)}”`;
    default:
      return `over the network (${address})`;
  }
}

export interface HubConnection {
  client: SyncClient;
  files: HubFiles;
}

export async function connectHub(pairing: Pairing, local: LibraryBackend, interactive: boolean): Promise<HubConnection> {
  switch (transportOf(pairing.address)) {
    case 'bluetooth': {
      const fetchOver = linkFetch(await bluetoothLink(pairing.hub.origin, interactive));
      return {
        client: createMessageClient(syncApiMeta, httpSend(BLUETOOTH_BASE, pairing.key, fetchOver)).sync,
        files: httpHubFiles(BLUETOOTH_BASE, pairing.key, local, fetchOver),
      };
    }
    case 'folder': {
      const { hub, copy } = await pairedFolder(pairing.hub.origin, interactive);
      const library = await local.getLibrary();
      return { client: hub.client, files: hub.files(local, { origin: library.origin, name: instanceName() }, folderKeepRule, copy) };
    }
    default:
      return { client: hubClient(pairing.address, pairing.key), files: hubFiles(pairing, local) };
  }
}

/** Whether this instance can sync with anything: over the network, over Bluetooth, through a folder, or as the hub. */
export const canSync = () => inDesktopApp() || canSyncOverNetwork() || canSyncOverBluetooth() || canSyncThroughFolder();

/**
 * Fetches a file this instance lacks from a hub it syncs with, for `fetchingMissingFiles`: from
 * the first that can be reached without asking (a network hub, or a Bluetooth link or folder
 * already open this session). False when there's none; an error saying why when none could
 * provide it.
 */
export async function fetchFromHub(backend: LibraryBackend, hash: FileHash): Promise<boolean> {
  const pairings = await readPairings(backend);
  if (!pairings.length) return false;
  const reasons: string[] = [];
  for (const pairing of pairings) {
    try {
      const { files } = await connectHub(pairing, backend, false);
      await files.download(hash);
      fileFetched();
      return true;
    } catch (e) {
      reasons.push(`${pairing.hub.name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  throw new Error(`This file isn’t on this device, and couldn’t be fetched (${reasons.join('; ')})`);
}
