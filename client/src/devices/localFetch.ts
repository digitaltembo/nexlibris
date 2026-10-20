import { createMessageClient, localHttpApiMeta, relayedFetch } from '@nexlibris/common';
import { androidTransport, inAndroidApp } from '../backends/androidBridge';

/**
 * Whether calls to devices on the local network go through the native app: in the Android app, whose
 * page is served over https and so may not call a reader's plain-http address itself.
 */
export const relaysLocalHttp = () => inAndroidApp();

/** `fetch` for a device on the local network (a reader's web server): the Android app's relay there, else `fetch`. */
export function localFetch(): typeof fetch {
  if (relaysLocalHttp()) return relayedFetch(createMessageClient(localHttpApiMeta, androidTransport()).localHttp);
  return (input, init) => fetch(input, init);
}
