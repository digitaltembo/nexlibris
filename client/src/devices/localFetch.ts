import { createMessageClient, localHttpApiMeta, relayedFetch } from '@nexlibris/common';
import { inMobileApp, mobileTransport } from '../backends/mobileBridge';

/**
 * Whether calls to devices on the local network go through the native app: in the Android and iOS
 * apps, whose pages are on secure origins and so may not call a reader's plain-http address themselves.
 */
export const relaysLocalHttp = () => inMobileApp();

/** `fetch` for a device on the local network (a reader's web server): the phone app's relay there, else `fetch`. */
export function localFetch(): typeof fetch {
  if (relaysLocalHttp()) return relayedFetch(createMessageClient(localHttpApiMeta, mobileTransport()).localHttp);
  return (input, init) => fetch(input, init);
}
