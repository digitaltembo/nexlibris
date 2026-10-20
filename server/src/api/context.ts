import { createSyncService, type Account } from '@nexlibris/common';
import type { RestApiContext } from 'estuary-rpc-server';
import type { Accounts } from '../accounts';
import type { Libraries } from '../libraries';
import type { Pairings, StoredPairing } from '../pairings';

/** The settings the API's endpoints and middleware read. */
export interface ApiSettings {
  /** What the server calls itself, e.g. as the hub of a pairing. */
  name: string;
  /** `auto`: only when the request came over https (or a trusted proxy says it did). */
  secureCookies: boolean | 'auto';
  /** Believes `X-Forwarded-Proto`, `X-Forwarded-Host` and `X-Forwarded-For`, behind a reverse proxy. */
  trustProxy: boolean;
}

/** What the endpoints work with: the server's stores, and each account's sync service. */
export interface Services {
  settings: ApiSettings;
  accounts: Accounts;
  libraries: Libraries;
  pairings: Pairings;
  /** The sync service of an account's library, made on first use. */
  syncOf(accountId: string): ReturnType<typeof createSyncService>;
  /** Drops an account's sync service, once its library has been replaced or removed. */
  resetSync(accountId: string): void;
}

/** Who made a call, which `authenticate` and the `withSession` middleware add to the context estuary-rpc-server passes each endpoint. */
export interface Who {
  /** Signed in (always, for endpoints that need the session). */
  account?: Account;
  /** For sync calls with a key: the pairing it's for. */
  pairing?: StoredPairing;
}

/** The context an endpoint is called with. */
export type Caller = RestApiContext & Who;

export const SIGNED_OUT = 'You’re signed out. Sign in again to open your library.';
export const NOT_PAIRED = 'This device isn’t paired with your account. Pair it again.';

/** The signed-in account, which `authenticate` checked for every endpoint that needs it. */
export const own = (caller: Caller) => caller.account!;

/** The pairing whose key came with a sync call, which `authenticate` checked for every endpoint that needs one. */
export const pairingOf = (caller: Caller) => caller.pairing!;
