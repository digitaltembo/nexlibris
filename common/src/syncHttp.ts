import type { LibraryBackend } from './backend';
import { createMessageClient, type RpcResponse, type RpcSend } from './rpc';
import { syncApiMeta } from './syncApi';
import { syncFileUrl, type HubFiles } from './syncFiles';
import type { FileHash } from './types';

/**
 * The sync API (`syncApi.ts`) over HTTP, as a hub serves it: each call is a POST of its request
 * as JSON, carrying the pairing's key, and the reply is an `RpcResponse`. For instances that can
 * reach the hub with `fetch` (a browser on the same network); the Android app goes through its
 * native side instead, as its page can't call plain http.
 */
export function httpSend(address: string, key?: string, fetchImpl: typeof fetch = fetch): RpcSend {
  return async (request) => {
    let response: Response;
    try {
      response = await fetchImpl(`${address.replace(/\/$/, '')}/${request.url}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(key && { Authorization: `Bearer ${key}` }) },
        body: JSON.stringify(request.body ?? null),
      });
    } catch {
      throw new Error(`Couldn’t reach ${address}. Check that it’s on the same network, with sync turned on.`);
    }
    return unwrapSyncResponse(response.status, await response.text());
  };
}

/** The value from a hub's reply, or its error, thrown. */
export function unwrapSyncResponse(status: number, text: string): unknown {
  let body: RpcResponse;
  try {
    body = JSON.parse(text) as RpcResponse;
  } catch {
    throw new Error(`The other device replied with something that isn’t nexlibris sync (HTTP ${status}).`);
  }
  if (!body.ok) throw new Error(body.message);
  return body.value;
}

/**
 * A hub's files over HTTP (see `syncFiles.ts`), for an instance that reaches the hub with `fetch`:
 * downloads are stored with `local.putFile`, uploads read with `local.getFile`.
 */
export function httpHubFiles(address: string, key: string, local: LibraryBackend, fetchImpl: typeof fetch = fetch): HubFiles {
  const base = address.replace(/\/$/, '');
  const sync = createMessageClient(syncApiMeta, httpSend(address, key, fetchImpl)).sync;
  const headers = { Authorization: `Bearer ${key}` };
  const call = async (hash: FileHash, init: RequestInit) => {
    try {
      return await fetchImpl(`${base}/${syncFileUrl(hash)}`, { ...init, headers });
    } catch {
      throw new Error(`Couldn’t reach ${address}. Check that it’s on the same network, with sync turned on.`);
    }
  };
  return {
    missing: (hashes) => sync.missing({ hashes }),
    async download(hash) {
      const response = await call(hash, {});
      if (!response.ok) unwrapSyncResponse(response.status, await response.text());
      const stored = await local.putFile(await response.blob());
      if (stored.hash !== hash) throw new Error('The file that arrived doesn’t match the one asked for.');
    },
    async upload(hash) {
      const blob = await local.getFile(hash);
      if (!blob) throw new Error('That file isn’t stored here.');
      const response = await call(hash, { method: 'PUT', body: blob });
      unwrapSyncResponse(response.status, await response.text());
    },
  };
}
