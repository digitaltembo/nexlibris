import { SESSION_COOKIE } from '@nexlibris/common';
import { ApiError } from 'estuary-rpc';
import { getCookies } from 'estuary-rpc-server';
import type { IncomingMessage } from 'node:http';

/** What a request says about itself: where it came from, and the session it carries. */

/** Whether the request came over https, or a trusted proxy says it did. */
export const isHttps = (req: IncomingMessage, trustProxy: boolean) =>
  'encrypted' in req.socket || (trustProxy && String(req.headers['x-forwarded-proto'] ?? '').split(',')[0]?.trim() === 'https');

/** The caller's address, for rate limits. */
export const clientAddress = (req: IncomingMessage, trustProxy: boolean) =>
  (trustProxy && String(req.headers['x-forwarded-for'] ?? '').split(',')[0]?.trim()) || req.socket.remoteAddress || '';

/** The session cookie, which the server's own pages send. */
export const cookieToken = (req: IncomingMessage) => getCookies(req)[SESSION_COOKIE];

/** The apps hold their session token themselves and send it as a bearer token, as they're on other origins. */
export const bearerToken = (req: IncomingMessage) => /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1];

export const sessionToken = (req: IncomingMessage) => cookieToken(req) ?? bearerToken(req);

/** Refuses calls a browser says came from another site, so pages elsewhere can't act as the signed-in user. */
export function sameSite(req: IncomingMessage, trustProxy: boolean) {
  const refuse = () => new ApiError(403, 'That has to come from this server’s own pages.');
  const site = req.headers['sec-fetch-site'];
  if (site && site !== 'same-origin' && site !== 'none') throw refuse();
  const origin = req.headers.origin;
  if (!origin || origin === 'null') return;
  const host = (trustProxy && req.headers['x-forwarded-host']) || req.headers.host;
  let from: string;
  try {
    from = new URL(origin).host;
  } catch {
    throw refuse();
  }
  if (from !== host) throw refuse();
}
