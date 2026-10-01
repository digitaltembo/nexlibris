import { resolveLibraryPath } from './fileStorage';
import { join } from 'node:path';

/** The app's origin. A standard, secure scheme, so the page gets a real origin and a secure context. */
export const APP_SCHEME = 'app';
export const APP_HOST = 'nexlibris';
export const APP_ORIGIN = `${APP_SCHEME}://${APP_HOST}`;

/** Whether a URL is the app's own. (Node's `URL` gives custom schemes a `null` origin, so origins can't be compared.) */
export function isAppUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === `${APP_SCHEME}:` && parsed.host === APP_HOST;
  } catch {
    return false;
  }
}

/**
 * What a request to the app's origin is for: a stored library file, which
 * `NativeStorage` fetches from `/library/files/…` (as on Android) to skip base64
 * and the IPC queue; or a file of the built client, with `index.html` for paths
 * that aren't files. Undefined for anything else.
 */
export function appFile(
  url: string,
  dirs: { client: string; library: string },
): { kind: 'library' | 'client'; file: string } | undefined {
  if (!isAppUrl(url)) return undefined;
  const parsed = new URL(url);
  let path: string;
  try {
    path = decodeURIComponent(parsed.pathname).replace(/^\/+/, '');
  } catch {
    return undefined;
  }
  try {
    if (path.startsWith('library/files/')) {
      return { kind: 'library', file: resolveLibraryPath(dirs.library, path.slice('library/'.length)) };
    }
    return { kind: 'client', file: resolveLibraryPath(dirs.client, path || 'index.html') };
  } catch {
    return undefined;
  }
}

/** Where the client's single page is, for paths that aren't files. */
export const clientIndex = (client: string) => join(client, 'index.html');
