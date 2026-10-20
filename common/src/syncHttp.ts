import type { LibraryBackend } from './backend';
import { httpClient, reaching } from './rest';
import type { SyncClient } from './sync';
import { syncApiMeta, syncFilesMeta } from './syncApi';
import type { HubFiles } from './syncFiles';

/**
 * The sync API (`syncApi.ts`) over HTTP, as a hub serves it (the desktop app, the M4 server, the
 * Android app over Bluetooth), called with estuary-rpc-client over `fetch`: each call a POST of its
 * request as JSON, carrying the pairing's key as a bearer token where its metadata asks for one,
 * answered with the response as JSON, or an error status with `{ status: 'error', message }`. For
 * instances that reach the hub with `fetch` (a browser on the same network, or `fetch` over a
 * Bluetooth link); the Android app goes through its native side instead (a `fetch` that relays,
 * `client/src/sync/hub.ts`), as its page can't call plain http.
 */

const unreachable = (address: string) => `Couldn’t reach ${address}. Check that it’s on the same network, with sync turned on.`;

const clientOptions = (address: string, key: string | undefined, fetchImpl: typeof fetch) => ({
  baseUrl: address,
  fetch: reaching(fetchImpl, unreachable(address)),
  ...(key && { authentication: { type: 'bearer' as const, token: key } }),
});

export function httpSyncClient(address: string, key?: string, fetchImpl: typeof fetch = (...args) => fetch(...args)): SyncClient {
  return httpClient(syncApiMeta, clientOptions(address, key, fetchImpl)).sync;
}

/**
 * A hub's files over HTTP (see `syncFiles.ts`, `syncFilesMeta`), for an instance that reaches the
 * hub with `fetch`: downloads are stored with `local.putFile`, uploads read with `local.getFile`.
 */
export function httpHubFiles(
  address: string,
  key: string,
  local: LibraryBackend,
  fetchImpl: typeof fetch = (...args) => fetch(...args),
): HubFiles {
  const options = clientOptions(address, key, fetchImpl);
  const sync = httpClient(syncApiMeta, options).sync;
  const files = httpClient(syncFilesMeta, options);
  const put = files.put as (input: { hash: string }, options: { body: Blob }) => Promise<unknown>;
  return {
    missing: (hashes) => sync.missing({ hashes }),
    async download(hash) {
      const response = (await files.get({ hash })) as Response;
      const stored = await local.putFile(await response.blob());
      if (stored.hash !== hash) throw new Error('The file that arrived doesn’t match the one asked for.');
    },
    async upload(hash) {
      const blob = await local.getFile(hash);
      if (!blob) throw new Error('That file isn’t stored here.');
      await put({ hash }, { body: blob });
    },
  };
}
