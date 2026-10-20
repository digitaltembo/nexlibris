import { post, type SimpleMeta } from 'estuary-rpc';

/**
 * Calling a sync hub from the Android app. Its page is served over https, so the WebView won't let
 * it call a hub's plain-http address on the local network; the app makes the call instead. It only
 * calls the sync API (`api/sync/…` on an http or https address), and passes the reply back as is,
 * for estuary-rpc-client (`client/src/sync/hub.ts` relays its `fetch`). Files go straight between the hub and the app's storage, streamed,
 * never through the page. Android only: a browser calls the hub with `fetch` (`httpSyncClient`, `httpHubFiles`).
 */

export interface PeerCallRequest {
  /** The hub, e.g. `http://192.168.0.11:47811`. */
  address: string;
  /** A sync API endpoint, e.g. `api/sync/state`. */
  url: string;
  /** The pairing's key; none for `api/sync/pair`. */
  key?: string;
  /** The request, as JSON. */
  body: string;
}

export interface PeerCallResult {
  status: number;
  /** The reply's body: an `RpcResponse` as JSON. */
  text: string;
}

export interface PeerFileRequest {
  address: string;
  key: string;
  /** The file, by hash (see `syncFiles.ts`). */
  hash: string;
}

export const peerApiMeta = {
  peer: {
    call: post<PeerCallRequest, PeerCallResult, SimpleMeta>('api/peer/call'),
    /** Fetches a file from the hub straight into the library's stored files; refused unless it hashes to `hash`. */
    download: post<PeerFileRequest, { size: number }, SimpleMeta>('api/peer/download'),
    /** Sends a stored file to the hub. */
    upload: post<PeerFileRequest, { size: number }, SimpleMeta>('api/peer/upload'),
  },
};

export type PeerApi = typeof peerApiMeta;

/** Whether a peer call is one the app should make: the sync API, on an http(s) address with no path. */
export function isPeerCallAllowed({ address, url }: Pick<PeerCallRequest, 'address' | 'url'>): boolean {
  return /^https?:\/\/[^/?#@]+$/.test(address) && /^api\/sync\/[a-z]+$/.test(url);
}
