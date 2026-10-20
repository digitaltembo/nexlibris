import { createSyncService, serverApiMeta, syncApiMeta, syncFilesMeta } from '@nexlibris/common';
import type { ApiTypeOf } from 'estuary-rpc';
import { createApiServer, type ApiContext } from 'estuary-rpc-server';
import type { Server } from 'node:http';
import { join, sep } from 'node:path';
import { createAccounts, type SignupPolicy } from './accounts';
import { authEndpoints } from './api/auth';
import type { ApiSettings, Services } from './api/context';
import { libraryEndpoints } from './api/library';
import { apiMiddleware } from './api/middleware';
import { syncEndpoints, syncFileEndpoints } from './api/sync';
import { createLibraries } from './libraries';
import type { ObjectStore } from './objectStore';
import { createPairings } from './pairings';

/**
 * The server's HTTP side, an estuary-rpc-server (`createApiServer`) serving three estuary-rpc APIs
 * by their metadata, and the web app as static files (open to anyone, as the app works signed out
 * with the library in the browser):
 * - the server API (`common/src/serverApi.ts`): accounts (`api/auth.ts`), and the signed-in
 *   account's library and its files (`api/library.ts`);
 * - the sync API (`common/src/syncApi.ts`) for each account's library, and its files (`api/sync.ts`).
 *
 * `api/middleware.ts` works out who's calling (the session, or a pairing's key) and refuses
 * cross-site changes; `api/context.ts` is what endpoints are given. Every book's file is served
 * only to the account it belongs to.
 */

export interface AppOptions extends ApiSettings {
  /** Accounts, sessions, pairings, and each account's library apart from its books' files. */
  dataDir: string;
  /** Where books' files go. */
  files: ObjectStore;
  /** Before every key in `files`, e.g. `nexlibris/`. */
  prefix?: string;
  /** The built web app (`client/dist`); none serves only the API. */
  clientDir?: string;
  signup: SignupPolicy;
  /** Serves on this server (an https one, say) rather than a new http one. It isn't made to listen. */
  server?: Server;
  now?: () => Date;
}

/** The largest JSON call: a whole library, when one's moved into an account. */
const MAX_JSON_BYTES = 256 * 1024 * 1024;

export function createApp(options: AppOptions) {
  const services = createServices(options);
  const meta = { ...serverApiMeta, ...syncApiMeta, syncFiles: syncFilesMeta };
  const endpoints = {
    auth: authEndpoints(services),
    library: libraryEndpoints(services),
    sync: syncEndpoints(services),
    syncFiles: syncFileEndpoints(services),
    // The endpoints read what `authenticate` and the middlewares put on the context, which the API's type can't say.
  } as unknown as ApiTypeOf<ApiContext, unknown, typeof meta>;

  const server = createApiServer(endpoints, meta, {
    ...(options.server && { server: options.server }),
    maxBodyBytes: MAX_JSON_BYTES,
    ...apiMiddleware(services),
    ...(options.clientDir && { staticFiles: webApp(options.clientDir) }),
  });

  const { accounts, libraries, pairings } = services;
  return { server, accounts, libraries, pairings };
}

export type App = ReturnType<typeof createApp>;

function createServices(options: AppOptions): Services {
  const now = options.now ?? (() => new Date());
  const libraries = createLibraries({ dataDir: options.dataDir, files: options.files, ...(options.prefix && { prefix: options.prefix }) });
  const syncServices = new Map<string, ReturnType<typeof createSyncService>>();
  return {
    settings: { name: options.name, secureCookies: options.secureCookies, trustProxy: options.trustProxy },
    accounts: createAccounts(options.dataDir, { signup: options.signup, now }),
    libraries,
    pairings: createPairings(options.dataDir, now),
    syncOf(accountId) {
      let service = syncServices.get(accountId);
      if (!service) {
        // Not scoped: an account's instances are all its own, and each sees the whole library.
        service = createSyncService(libraries.backend(accountId), { name: () => options.name });
        syncServices.set(accountId, service);
      }
      return service;
    },
    resetSync: (accountId) => void syncServices.delete(accountId),
  };
}

/** The web app as estuary-rpc-server's static files. It's one page: anything that isn't a file is it. */
const webApp = (clientDir: string) => ({
  fileRoot: clientDir,
  defaultFile: 'index.html',
  defaultCode: 200,
  apiPrefixes: ['api/'],
  headers: (file: string) => ({
    'Cache-Control': file.startsWith(join(clientDir, 'assets') + sep) ? 'public, max-age=31536000, immutable' : 'no-cache',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'SAMEORIGIN',
    'Referrer-Policy': 'same-origin',
  }),
});
