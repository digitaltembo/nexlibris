import {
  createMessageClient,
  httpHubFiles,
  peerApiMeta,
  userData,
  type FileHash,
  type HubFiles,
  type Item,
  type Library,
  type LibraryBackend,
  type Pairing,
} from '@nexlibris/common';
import { inMobileApp, mobileTransport } from '../backends/mobileBridge';
import { filterItems } from '../library/search';
import { hubClient, isOwnServer } from './hub';
import { inDesktopApp } from '../backends/desktopBridge';
import { serverConnection } from '../library/account';

/**
 * A hub's files (see `common/src/syncFiles.ts`). In the phone apps they go straight between the
 * hub and the app's storage, streamed by the app; a browser moves them with `fetch`.
 */
export function hubFiles(pairing: Pairing, backend: LibraryBackend): HubFiles {
  const server = isOwnServer(pairing.address) && inDesktopApp() ? serverConnection() : undefined;
  if (server) return httpHubFiles(server.base ?? pairing.address, pairing.key, backend, server.fetch);
  if (!inMobileApp()) return httpHubFiles(pairing.address, pairing.key, backend);
  const peer = createMessageClient(peerApiMeta, mobileTransport()).peer;
  const request = (hash: FileHash) => ({ address: pairing.address, key: pairing.key, hash });
  return {
    missing: (hashes) => hubClient(pairing.address, pairing.key).missing({ hashes }),
    download: async (hash) => void (await peer.download(request(hash))),
    upload: async (hash) => void (await peer.upload(request(hash))),
  };
}

/** Which items' files to keep here under a pairing's `keepFiles` search; all of them when it has none. */
export function keepRule(keepFiles: string | undefined, library: Library): ((item: Item) => boolean) | undefined {
  const query = keepFiles?.trim();
  if (!query) return undefined;
  const kept = new Set(filterItems(Object.values(library.items), query, { ratings: userData(library).ratings }).map((item) => item.id));
  return (item) => kept.has(item.id);
}

const fetched = new EventTarget();

/** Says that files arrived from the hub, for anything showing which are downloaded. */
export const fileFetched = () => fetched.dispatchEvent(new Event('fetched'));

/** Calls `listener` whenever files arrive from the hub; returns how to stop. */
export function onFileFetched(listener: () => void): () => void {
  fetched.addEventListener('fetched', listener);
  return () => fetched.removeEventListener('fetched', listener);
}
