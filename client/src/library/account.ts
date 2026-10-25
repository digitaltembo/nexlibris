import {
  isLocalAddress,
  SERVER_HEADER,
  serverAddress,
  serverClient,
  ServerLibraryBackend,
  type Credentials,
  type LibraryBackend,
  type MessageClient,
  type ServerApi,
  type SessionInfo,
} from '@nexlibris/common';
import { useEffect, useState } from 'react';
import { inMobileApp } from '../backends/mobileBridge';
import { inDesktopApp } from '../backends/desktopBridge';
import { localFetch } from '../devices/localFetch';
import { t } from '../i18n';

/**
 * The nexlibris server (M4) this instance uses, if any, and the account signed in to it. Signed
 * in, the library can be kept in the account (`libraryFolder.ts`, kind `cloud`), or kept here and
 * synced with it (a connection, like another instance: `PairServer` in `components/InstanceSync.tsx`).
 *
 * In a browser it's the server the page came from, if it came from one (a page from a static host
 * has none), signed in by the session cookie. The desktop and phone apps use a server at an
 * address the user gives (self-hosting), kept with the session's token in local storage, and send
 * the token as a bearer token. The desktop app calls it through its main process
 * (`common/src/appServer.ts`), as its `app://` page may not call it freely; the Android and iOS
 * apps call a server on the local network through their relay (`localHttpApi.ts`; their secure pages
 * may not call plain http), and one elsewhere directly, over https.
 */

/** Whether this instance chooses its server (the apps), rather than using the one its page came from. */
export const choosesServer = () => inMobileApp() || inDesktopApp();

const SERVER_KEY = 'nexlibris:server';

interface ChosenServer {
  url: string;
  /** The session's token, while signed in. */
  token?: string;
}

function chosen(): ChosenServer | undefined {
  try {
    const value = JSON.parse(localStorage.getItem(SERVER_KEY) ?? 'null') as ChosenServer | null;
    return typeof value?.url === 'string' ? value : undefined;
  } catch {
    return undefined;
  }
}

function choose(server: ChosenServer | undefined) {
  try {
    if (server) localStorage.setItem(SERVER_KEY, JSON.stringify(server));
    else localStorage.removeItem(SERVER_KEY);
  } catch {
    // Without storage, the choice lasts as long as the page.
  }
}

/** In the apps, the address of the server chosen, if one has been. */
export const chosenServer = (): string | undefined => (choosesServer() ? chosen()?.url : undefined);

/** The server's address, as pairings with it name it: the page's origin in a browser, the chosen server in the apps. */
export function serverUrl(): string | undefined {
  if (choosesServer()) return chosen()?.url;
  return typeof location === 'undefined' ? undefined : location.origin;
}

/** How to call a server: the base its API's addresses are relative to, and the `fetch` that reaches it. */
export interface ServerConnection {
  /** Undefined for the page's own origin. */
  base?: string;
  fetch: typeof fetch;
}

/** Calls made as the apps make them: with the session's token, unless they carry a key of their own (sync). */
const withToken =
  (fetchImpl: typeof fetch, token: string | undefined, headers: Record<string, string> = {}): typeof fetch =>
  (input, init) => {
    const all = new Headers(init?.headers);
    for (const [name, value] of Object.entries(headers)) all.set(name, value);
    if (token && !all.has('Authorization')) all.set('Authorization', `Bearer ${token}`);
    return fetchImpl(input, { ...init, headers: all });
  };

function connectionTo(url: string, token?: string): ServerConnection {
  if (inDesktopApp()) {
    return { base: `${location.origin}/server`, fetch: withToken((input, init) => fetch(input, init), token, { [SERVER_HEADER]: url }) };
  }
  return { base: url, fetch: withToken(isLocalAddress(url) ? localFetch() : (input, init) => fetch(input, init), token) };
}

/** How this instance calls its server; undefined in an app that hasn't chosen one. */
export function serverConnection(): ServerConnection | undefined {
  if (!choosesServer()) return { fetch: (input, init) => fetch(input, init) };
  const server = chosen();
  return server && connectionTo(server.url, server.token);
}

/** The server API's client, for this instance's server. */
export function serverApi(): MessageClient<ServerApi> {
  const connection = serverConnection();
  if (!connection) throw new Error(t('account.errors.chooseServer'));
  return serverClient(connection.base, connection.fetch);
}

/** The library in the account signed in to this instance's server. */
export function cloudBackend(): LibraryBackend {
  const connection = serverConnection();
  if (!connection) throw new Error(t('account.errors.chooseServer'));
  return new ServerLibraryBackend(connection.base, connection.fetch);
}

let probe: Promise<SessionInfo | undefined> | undefined;
const changes = new EventTarget();

/**
 * Who's signed in, asked of the server once per page (and after signing in or out); undefined
 * without one, or if it can't be reached.
 */
export function serverSession(refresh = false): Promise<SessionInfo | undefined> {
  if (typeof location === 'undefined') return Promise.resolve(undefined);
  if (!probe || refresh) {
    // A build for a static host (GitHub Pages: `VITE_STATIC_HOST=true`) knows there's none to ask.
    const connection = import.meta.env.VITE_STATIC_HOST === 'true' && !choosesServer() ? undefined : serverConnection();
    // A 404, or a page instead of the API, is a page from somewhere without a server.
    probe = connection
      ? serverClient(connection.base, connection.fetch)
          .auth.session(null)
          .then(nexlibrisSession)
          .catch(() => undefined)
      : Promise.resolve(undefined);
  }
  return probe;
}

/** A session from the server, or undefined if what answered isn't a nexlibris server. */
const nexlibrisSession = (session: unknown): SessionInfo | undefined =>
  session && typeof session === 'object' && typeof (session as SessionInfo).name === 'string' && typeof (session as SessionInfo).signup === 'boolean'
    ? (session as SessionInfo)
    : undefined;

const settled = (session: SessionInfo | undefined) => {
  if (session?.token !== undefined) {
    // An app's token is kept with the server's address, and never handed round with the session.
    const server = chosen();
    if (server) choose({ ...server, token: session.token });
    const { token: _, ...rest } = session;
    session = rest;
  }
  probe = Promise.resolve(session);
  changes.dispatchEvent(new Event('change'));
  return session;
};

/** The apps sign in for the session's token, as a cookie wouldn't reach the server from their pages. */
const asked = (credentials: Credentials): Credentials => (choosesServer() ? { ...credentials, token: true } : credentials);

export const signIn = async (credentials: Credentials) => settled(await serverApi().auth.signIn(asked(credentials)))!;
export const signUp = async (credentials: Credentials) => settled(await serverApi().auth.signUp(asked(credentials)))!;

export async function signOut(): Promise<SessionInfo | undefined> {
  const server = chosen();
  let session: SessionInfo | undefined;
  try {
    session = await serverApi().auth.signOut(null);
  } catch (e) {
    // An app is signed out here even if the server couldn't be told: it forgets the token.
    if (!server?.token) throw e;
  }
  if (server?.token) choose({ url: server.url });
  return settled(session ?? (await serverSession(true)));
}

export async function changePassword(password: string, newPassword: string): Promise<void> {
  await serverApi().auth.changePassword({ password, newPassword });
}

/**
 * In the apps, uses the nexlibris server at the address typed (`https://` unless it says
 * otherwise), once it's answered as one. Signs out of the server chosen before.
 */
export async function chooseServer(typed: string): Promise<SessionInfo> {
  const url = serverAddress(typed);
  if (!url) throw new Error(t('account.errors.notAddress'));
  if (inMobileApp() && url.startsWith('http:') && !isLocalAddress(url)) {
    throw new Error(t('account.errors.needsHttps'));
  }
  // Sync goes through the app's relay (`PeerService.kt`, `PeerService.swift`), which calls servers at their origin.
  if (inMobileApp() && new URL(url).pathname !== '/') throw new Error(t('account.errors.noPath'));
  const connection = connectionTo(url);
  let session: SessionInfo | undefined;
  try {
    session = nexlibrisSession(await serverClient(connection.base, connection.fetch).auth.session(null));
  } catch (e) {
    throw new Error(t('account.errors.unreachable', { url, message: e instanceof Error ? e.message : String(e) }));
  }
  if (!session) throw new Error(t('account.errors.notServer', { url }));
  if (chosen()?.token) await signOut().catch(() => undefined);
  choose({ url });
  return settled(session)!;
}

/** In the apps, stops using a server (signing out of it). */
export async function forgetServer(): Promise<void> {
  if (chosen()?.token) await signOut().catch(() => undefined);
  choose(undefined);
  setWantsCloud(false);
  settled(undefined);
}

/** Calls `listener` after signing in or out, or choosing a server; returns how to stop. */
export function onSessionChange(listener: () => void): () => void {
  changes.addEventListener('change', listener);
  return () => changes.removeEventListener('change', listener);
}

const PLACE_KEY = 'nexlibris:library-place';

/** Whether this instance keeps its library in the account rather than in its own storage. */
export function wantsCloud(): boolean {
  try {
    return localStorage.getItem(PLACE_KEY) === 'cloud';
  } catch {
    return false;
  }
}

export function setWantsCloud(cloud: boolean) {
  try {
    if (cloud) localStorage.setItem(PLACE_KEY, 'cloud');
    else localStorage.removeItem(PLACE_KEY);
  } catch {
    // Without storage, the choice lasts as long as the page.
  }
}

/** The session (see {@link serverSession}) and whether it's been asked yet, kept current as people sign in and out. */
export function useServerState(): { known: boolean; session?: SessionInfo } {
  const [state, setState] = useState<{ known: boolean; session?: SessionInfo }>({ known: false });
  useEffect(() => {
    let live = true;
    const update = () => void serverSession().then((session) => live && setState({ known: true, ...(session && { session }) }));
    update();
    const stop = onSessionChange(update);
    return () => {
      live = false;
      stop();
    };
  }, []);
  return state;
}

/** The session (see {@link serverSession}), kept current as people sign in and out; undefined without a server, or until it's known. */
export const useServerSession = (): SessionInfo | undefined => useServerState().session;
