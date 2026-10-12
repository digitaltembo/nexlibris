import type { LibraryBackend } from '@nexlibris/common';

/**
 * Sign-ins for catalogs that need one (HTTP Basic auth), per connection. Kept in this instance's
 * local state, so never in the library: not synced to other devices, not in backups. Sent only to
 * the catalog's own origin (`authHeaders`), never to other servers its links lead to.
 */

export interface CatalogCredentials {
  username: string;
  password: string;
}

/** A catalog's sign-in as it's sent: the `Authorization` header, for addresses at `origin`. */
export interface CatalogAuth {
  origin: string;
  authorization: string;
}

const KEY = 'catalog-credentials';

const listeners = new Set<() => void>();
/** Called when a sign-in is set or forgotten, so catalogs being shown read theirs again. */
export function onCredentialsChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

type Stored = Record<string, CatalogCredentials>;

export async function readCredentials(backend: LibraryBackend, deviceId: string): Promise<CatalogCredentials | undefined> {
  return (await backend.readLocalState<Stored>(KEY))?.[deviceId];
}

/** Sets a connection's sign-in, or forgets it (`undefined`, or an empty user name and password). */
export async function writeCredentials(backend: LibraryBackend, deviceId: string, credentials: CatalogCredentials | undefined) {
  const stored = { ...(await backend.readLocalState<Stored>(KEY)) };
  if (credentials && (credentials.username || credentials.password)) stored[deviceId] = credentials;
  else delete stored[deviceId];
  await backend.writeLocalState(KEY, stored);
  for (const listener of listeners) listener();
}

/** Basic auth's header value: the user name and password, as UTF-8, in base64. */
export function basicAuthorization({ username, password }: CatalogCredentials): string {
  const bytes = new TextEncoder().encode(`${username}:${password}`);
  return `Basic ${btoa(String.fromCharCode(...bytes))}`;
}

/** How to sign in to the catalog starting at `root`, if its connection has a sign-in. */
export async function catalogAuth(backend: LibraryBackend, deviceId: string, root: string): Promise<CatalogAuth | undefined> {
  const credentials = await readCredentials(backend, deviceId);
  if (!credentials) return undefined;
  try {
    return { origin: new URL(root).origin, authorization: basicAuthorization(credentials) };
  } catch {
    return undefined;
  }
}

/** The sign-in header for `url`, if it's on the catalog's own origin. */
export function authHeaders(auth: CatalogAuth | undefined, url: string): Record<string, string> {
  if (!auth) return {};
  try {
    return new URL(url).origin === auth.origin ? { Authorization: auth.authorization } : {};
  } catch {
    return {};
  }
}
