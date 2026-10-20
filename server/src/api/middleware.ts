import { OperationError, RevisionMismatchError } from '@nexlibris/common';
import { ApiError, type SimpleMeta, TransportType } from 'estuary-rpc';
import type { ApiContext } from 'estuary-rpc-server';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { SignInError } from '../accounts';
import { NOT_PAIRED, SIGNED_OUT, type Services, type Who } from './context';
import { bearerToken, cookieToken, sameSite, sessionToken } from './request';

/**
 * Who's calling, as estuary-rpc-server's options work it out: `authenticate` checks the session
 * (cookie, or an app's bearer token) of endpoints whose metadata asks for it, putting the account
 * on the context, and the bearer key of those that ask for one, putting the pairing there; the
 * `withSession` middleware puts the account, if any, on the context of endpoints that don't require
 * one. Calls that change anything with the cookie must come from the server's own pages
 * (`sameSiteOnly`): a browser's `Origin` and `Sec-Fetch-Site` say where a call came from, and JSON
 * calls need a JSON content type. The API answers other origins (CORS, `apiHeaders`) without
 * credentials, for the apps: a browser never sends the cookie with another site's calls, and
 * without the cookie or a token there's nothing to act with.
 */
export function apiMiddleware({ accounts, pairings, settings }: Services) {
  /** For endpoints whose metadata asks for authentication: the session must be a signed-in account's, a bearer key a pairing's. */
  async function authenticate(auth: NonNullable<ApiContext['authentication']>, context: ApiContext): Promise<boolean> {
    if (auth.type === 'cookie') {
      const account = await accounts.session(auth.keyPair[1] || bearerToken(context.req));
      if (!account) throw new ApiError(401, SIGNED_OUT);
      Object.assign(context, { account } satisfies Who);
      return true;
    }
    if (auth.type === 'bearer') {
      const pairing = await pairings.byKey(auth.token);
      if (!pairing) throw new ApiError(401, NOT_PAIRED);
      Object.assign(context, { pairing } satisfies Who);
      return true;
    }
    return false;
  }

  /** Endpoints that don't need the session (the session's own, pairing) still see who's signed in. */
  async function withSession(context: ApiContext, meta: SimpleMeta): Promise<boolean> {
    if (!meta.authentication) {
      const account = await accounts.session(sessionToken(context.req));
      if (account) Object.assign(context, { account } satisfies Who);
    }
    return true;
  }

  /** Changes made with the session come from this server's own pages, as JSON (files as they are). */
  async function sameSiteOnly({ req }: ApiContext, meta: SimpleMeta): Promise<boolean> {
    if (meta.method === 'GET' || meta.authentication?.type === 'bearer') return true;
    // Without the cookie there's nothing a browser added that another site could borrow (an app's
    // calls carry their token instead). Signing in for a cookie is checked where it's set.
    if (!cookieToken(req)) return true;
    if (meta.transport?.transportType !== TransportType.RAW && !/^application\/json\b/.test(req.headers['content-type'] ?? '')) {
      throw new ApiError(415, 'Send JSON.');
    }
    sameSite(req, settings.trustProxy);
    return true;
  }

  return { authenticate, middlewares: [withSession, sameSiteOnly], restMiddleware: [apiHeaders], mapError };
}

/**
 * A rest middleware for the API's calls: never cached, never sniffed; and open to other origins
 * (the apps, whose pages call it from their own, with a token), so its preflights are answered here.
 * Without credentials (`*`): a browser never sends the cookie with another site's calls, and other
 * sites' calls get nothing they couldn't without a token.
 */
async function apiHeaders(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Cache-Control', 'no-store');
  if (!req.url?.startsWith('/api/')) return true;
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, OPTIONS');
  if (req.method !== 'OPTIONS') return true;
  res.writeHead(204).end();
  return false;
}

/**
 * Endpoints refuse calls by throwing estuary-rpc's `ApiError` with a status; this gives the
 * library's own errors theirs: a library that moved on (409), a refused operation or a message for
 * the user (400; a plain `Error`, not a system one, whose message may name paths). Anything else
 * is a logged 500.
 */
function mapError(e: unknown): ApiError | undefined {
  if (e instanceof RevisionMismatchError) return new ApiError(409, e.message);
  if (e instanceof OperationError || e instanceof SignInError) return new ApiError(400, e.message);
  if (e instanceof Error && e.constructor === Error && !('code' in e)) return new ApiError(400, e.message);
  return undefined;
}
