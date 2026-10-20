import { createMessageClient, httpSyncClient, peerApiMeta, type SyncClient } from '@nexlibris/common';
import { inIosApp } from '../backends/iosBridge';
import { inMobileApp, mobileTransport } from '../backends/mobileBridge';
import { inDesktopApp } from '../backends/desktopBridge';
import { serverConnection, serverUrl } from '../library/account';

/**
 * Reaching a sync hub (the desktop app, or the server) from this instance. The phone apps' pages
 * are on secure origins and may not call a plain-http address, so the app makes the call (the peer
 * API, which adds the key), given to estuary-rpc-client as its `fetch`; a browser calls it with `fetch`.
 */
export function hubClient(address: string, key?: string): SyncClient {
  // The desktop app reaches its server through its main process, as it does for its account.
  const server = isOwnServer(address) && inDesktopApp() ? serverConnection() : undefined;
  if (server) return httpSyncClient(server.base ?? address, key, server.fetch);
  if (!inMobileApp()) return httpSyncClient(address, key);
  const peer = createMessageClient(peerApiMeta, mobileTransport()).peer;
  const relay: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const { status, text } = await peer.call({
      address,
      url: `${url.pathname.slice(1)}${url.search}`,
      ...(key && { key }),
      body: typeof init?.body === 'string' ? init.body : 'null',
    });
    return new Response(status === 204 ? null : text, { status });
  };
  return httpSyncClient(address, key, relay);
}

/**
 * Whether this instance can sync with a hub over the network: the phone apps can, and so can a
 * browser if the page itself is plain http (a browser won't let an https page call an http
 * address). The desktop app is the network's hub, so it doesn't.
 */
export const canSyncOverNetwork = () =>
  inMobileApp() || (!inDesktopApp() && typeof location !== 'undefined' && location.protocol === 'http:');

/** What to call this instance when pairing, e.g. "Pixel 7a". */
export function instanceName(): string {
  const ua = typeof navigator === 'undefined' ? '' : navigator.userAgent;
  // Android WebViews still name the model; reduced user agents say just "K".
  const model = /Android [\d.]+; ([^;)]+?)(?: Build\/[^;)]*)?[;)]/.exec(ua)?.[1]?.trim();
  if (model && model !== 'K') return model;
  if (inIosApp()) return /iPad/.test(ua) || !/iPhone/.test(ua) ? 'iPad' : 'iPhone';
  if (inMobileApp()) return 'Android device';
  const browser = /Firefox\//.test(ua) ? 'Firefox' : /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'A browser';
  return `${browser} on ${/Mac OS X/.test(ua) ? 'a Mac' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : 'this computer'}`;
}

/**
 * Whether this instance can sync with its server (M4), whatever the page's scheme: a page's own
 * origin is always reachable, and the apps reach theirs. Only with an account there does it pair
 * with it (`PairServer`).
 */
export const canSyncWithServer = () =>
  inMobileApp() || inDesktopApp() || (typeof location !== 'undefined' && /^https?:$/.test(location.protocol));

/** Whether a pairing is with this instance's server (`account.ts`): the page's own, or the one an app chose. */
export const isOwnServer = (address: string) => address === serverUrl();

/**
 * The sync API on this instance's server, for pairing with it: called as the account is (signed in
 * by the session, which pairs without a code).
 */
export function ownServerClient(): { address: string; client: SyncClient } {
  const address = serverUrl();
  const server = serverConnection();
  if (!address || !server) throw new Error('Choose a nexlibris server first (Account…).');
  return { address, client: httpSyncClient(server.base ?? address, undefined, server.fetch) };
}
