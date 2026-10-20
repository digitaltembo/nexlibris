/**
 * The desktop app's way to the nexlibris server the user chose (M4): its page is on `app://nexlibris`,
 * from which the browser won't let it call a server elsewhere freely (CORS, and a plain-http server
 * at all), so it calls `app://nexlibris/server/<path>` with the server's address in
 * {@link SERVER_HEADER}, and the main process (`desktop/src/serverProxy.ts`) makes the call to
 * `<address>/<path>`, passing back the reply. Only the call's own headers go (`Authorization`,
 * `Content-Type`, `Accept`), never cookies. Desktop only: the Android app calls a server on the
 * local network through its relay (`localHttpApi.ts`), and one elsewhere directly (https, CORS).
 */

import { isLocalAddress } from './localHttpApi';

/** Where the page calls the server through the desktop app, under its own origin. */
export const SERVER_PROXY_PATH = '/server/';

/** The server's address (`https://books.example.org`, maybe with a path), on calls through the proxy. */
export const SERVER_HEADER = 'X-Nexlibris-Server';

/**
 * A server's address as the user typed it, made into a URL to call it at, without a trailing
 * slash; undefined if it isn't one. Without a scheme it's `https://`, or `http://` on the local
 * network (where a self-hosted server usually is); a scheme typed is kept.
 */
export function serverAddress(typed: string): string | undefined {
  const text = typed.trim();
  if (!text) return undefined;
  let url: URL;
  try {
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) url = new URL(text);
    else {
      url = new URL(`https://${text}`);
      if (isLocalAddress(url.href)) url = new URL(`http://${text}`);
    }
  } catch {
    return undefined;
  }
  if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.search || url.hash || !url.hostname) return undefined;
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}
