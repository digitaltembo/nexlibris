import {
  createMessageClient,
  httpSend,
  peerApiMeta,
  syncApiMeta,
  unwrapSyncResponse,
  type RpcSend,
  type SyncClient,
} from '@nexlibris/common';
import { androidTransport, inAndroidApp } from '../backends/androidBridge';
import { inDesktopApp } from '../backends/desktopBridge';

/**
 * Reaching a sync hub (the desktop app) from this instance. The Android app's page is served over
 * https and may not call a plain-http address, so the app makes the call (the peer API); a browser
 * calls it with `fetch`.
 */
export function hubSend(address: string, key?: string): RpcSend {
  if (!inAndroidApp()) return httpSend(address, key);
  const peer = createMessageClient(peerApiMeta, androidTransport()).peer;
  return async (request) => {
    const { status, text } = await peer.call({ address, url: request.url, ...(key && { key }), body: JSON.stringify(request.body ?? null) });
    return unwrapSyncResponse(status, text);
  };
}

export const hubClient = (address: string, key?: string): SyncClient => createMessageClient(syncApiMeta, hubSend(address, key)).sync;

/**
 * Whether this instance can sync with a hub over the network: the Android app can, and so can a
 * browser if the page itself is plain http (a browser won't let an https page call an http
 * address). The desktop app is the network's hub, so it doesn't.
 */
export const canSyncOverNetwork = () =>
  inAndroidApp() || (!inDesktopApp() && typeof location !== 'undefined' && location.protocol === 'http:');

/** What to call this instance when pairing, e.g. "Pixel 7a". */
export function instanceName(): string {
  const ua = typeof navigator === 'undefined' ? '' : navigator.userAgent;
  // Android WebViews still name the model; reduced user agents say just "K".
  const model = /Android [\d.]+; ([^;)]+?)(?: Build\/[^;)]*)?[;)]/.exec(ua)?.[1]?.trim();
  if (model && model !== 'K') return model;
  if (inAndroidApp()) return 'Android device';
  const browser = /Firefox\//.test(ua) ? 'Firefox' : /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'A browser';
  return `${browser} on ${/Mac OS X/.test(ua) ? 'a Mac' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : 'this computer'}`;
}
