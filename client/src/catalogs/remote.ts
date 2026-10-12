import { createMessageClient, remoteApiMeta, type RemoteText } from '@nexlibris/common';
import { inDesktopApp, desktopSend } from '../backends/desktopBridge';
import { formatFromName, type FormatId } from '../formats/formats';
import type { ImportSource } from '../library/importFiles';
import { storedSource } from '../library/nativeImport';
import { authHeaders, type CatalogAuth } from './credentials';

/**
 * Reaching OPDS catalogs: in the desktop app through its main process (`common/src/remoteApi.ts`),
 * which any server allows; in a browser (and on Android) with `fetch`, which only servers that let
 * web pages read them do (CORS). Project Gutenberg's catalog does; its book files don't.
 */

/** Fetches a page's text; `headers` only where they can be sent without asking the server first. */
export type TextFetcher = (url: string, headers?: Record<string, string>) => Promise<RemoteText>;

const desktopRemote = () => createMessageClient(remoteApiMeta, desktopSend()).remote;

const unreachable = (url: string, signedIn: boolean) =>
  new Error(
    `Couldn’t reach ${new URL(url).host}. Check the address and your connection${
      inDesktopApp()
        ? ''
        : signedIn
          ? '; or the server may not let web pages sign in to it (it has to allow the Authorization header), which the desktop app can'
          : '; or the server may not let web pages read it, which the desktop app can'
    }.`,
  );

/** How to fetch catalog pages here, signing in to the catalog's own server with `auth`. */
export function textFetcher(auth?: CatalogAuth): TextFetcher {
  if (inDesktopApp()) {
    const remote = desktopRemote();
    return (url, headers) => {
      const all = { ...headers, ...authHeaders(auth, url) };
      return remote.fetchText({ url, ...(Object.keys(all).length && { headers: all }) });
    };
  }
  // A browser checks its own cached copy with the server (`no-cache`); conditional headers of our own would
  // make it ask the server's permission first, which catalogs that allow plain reads often don't give. A
  // sign-in has to ask anyway.
  return async (url) => {
    const signIn = authHeaders(auth, url);
    let response: Response;
    try {
      response = await fetch(url, { cache: 'no-cache', credentials: 'omit', headers: signIn });
    } catch {
      throw unreachable(url, 'Authorization' in signIn);
    }
    const etag = response.headers.get('etag');
    const lastModified = response.headers.get('last-modified');
    return { status: response.status, url: response.url || url, text: await response.text(), ...(etag && { etag }), ...(lastModified && { lastModified }) };
  };
}

/** A name with the format's extension, so the import knows what it is. */
function named(name: string, format: FormatId | undefined): string {
  if (formatFromName(name) || !format) return name;
  return `${name.replace(/\.[a-z0-9]+$/i, '')}.${format}`;
}

/** The download's name from where it ended up. */
const nameFrom = (url: string) => decodeURIComponent(new URL(url).pathname.split('/').filter(Boolean).pop() ?? 'download');

/**
 * Downloads a book for importing: in the desktop app, into the library's stored files by its main
 * process; in a browser, into the page, if the server allows (else it says so, with the link to
 * download it by hand).
 */
export async function downloadBook(url: string, format?: FormatId, auth?: CatalogAuth): Promise<ImportSource> {
  const signIn = authHeaders(auth, url);
  if (inDesktopApp()) {
    const { hash, size, name } = await desktopRemote().download({ url, ...('Authorization' in signIn && { headers: signIn }) });
    return storedSource({ name: named(name, format), hash, size });
  }
  let response: Response;
  try {
    response = await fetch(url, { credentials: 'omit', headers: signIn });
  } catch {
    throw new CantDownload(url);
  }
  if (response.status === 401 || response.status === 403) throw new Error('The catalog refused the user name and password.');
  if (!response.ok) throw new Error(`The server said ${response.status} ${response.statusText}.`);
  const blob = await response.blob();
  return new File([blob], named(nameFrom(response.url || url), format), { type: blob.type });
}

/** The browser wasn't allowed to download the file: the user can, from its link, then import it. */
export class CantDownload extends Error {
  constructor(readonly url: string) {
    super('The server doesn’t let web pages download its books. Download it from the link, then import it; the desktop app can add it directly.');
    this.name = 'CantDownload';
  }
}

/**
 * An image of a catalog that needs a sign-in, which an `<img>` can't send: read with the sign-in,
 * as a blob. Undefined if the image isn't on the catalog's server, so needs none (shown by address).
 */
export async function fetchSignedInImage(url: string, auth: CatalogAuth | undefined): Promise<Blob | undefined> {
  const signIn = authHeaders(auth, url);
  if (!('Authorization' in signIn)) return undefined;
  if (inDesktopApp()) {
    const { status, type, data } = await desktopRemote().fetchBytes({ url, headers: signIn });
    if (status < 200 || status >= 300) throw new Error(`The server said ${status}.`);
    const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
    return new Blob([bytes], type ? { type } : {});
  }
  const response = await fetch(url, { credentials: 'omit', headers: signIn });
  if (!response.ok) throw new Error(`The server said ${response.status}.`);
  return response.blob();
}
