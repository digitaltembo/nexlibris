import { errorBody, serveOpds, type Account } from '@nexlibris/common';
import { createHash } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { SignInError } from '../accounts';
import type { Services } from './context';
import { clientAddress, sessionToken } from './request';

/** Where the account's OPDS catalogs are served. */
export const OPDS_PREFIX = 'opds/';

/**
 * The signed-in account's OPDS catalogs, served live (`common/src/opdsServer.ts`) at `/opds/`: a
 * rest middleware answering every request under it. OPDS readers sign in with HTTP Basic (the
 * account's name and password, checked by `Accounts.verify`); the server's own pages and the apps
 * are signed in already (the session cookie, or an app's token). Without either, or with a wrong
 * one, the answer asks for Basic. Reads only: GET and HEAD.
 */
export function opdsMiddleware({ accounts, libraries, settings }: Services) {
  async function who(req: IncomingMessage): Promise<Account | undefined> {
    const basic = /^Basic (.+)$/i.exec(req.headers.authorization ?? '')?.[1];
    if (!basic) return accounts.session(sessionToken(req));
    const decoded = Buffer.from(basic, 'base64').toString('utf8');
    const colon = decoded.indexOf(':');
    if (colon < 0) return undefined;
    return accounts.verify(decoded.slice(0, colon), decoded.slice(colon + 1), clientAddress(req, settings.trustProxy));
  }

  return async function opds(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const root = `/${OPDS_PREFIX.slice(0, -1)}`;
    if (url.pathname !== root && !url.pathname.startsWith(`/${OPDS_PREFIX}`)) return true;

    // Open to other origins, as the API is: web readers send their own Authorization header.
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization');
    res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
    const fail = (status: number, message: string, headers: Record<string, string> = {}) => {
      res.writeHead(status, { 'Content-Type': 'application/json', ...headers }).end(req.method === 'HEAD' ? undefined : JSON.stringify(errorBody(message)));
      return false;
    };
    const done = (status: number, headers: Record<string, string> = {}) => {
      res.writeHead(status, headers).end();
      return false;
    };
    if (req.method === 'OPTIONS') return done(204);
    if (req.method !== 'GET' && req.method !== 'HEAD') return fail(405, 'Catalogs are only read.', { Allow: 'GET, HEAD, OPTIONS' });

    const challenge = { 'WWW-Authenticate': `Basic realm="${settings.name.replace(/["\\]/g, '')}", charset="UTF-8"` };
    let account: Account | undefined;
    try {
      account = await who(req);
    } catch (e) {
      if (!(e instanceof SignInError)) throw e;
      return fail(e.message === new SignInError().message ? 401 : 429, e.message, challenge);
    }
    if (!account) return fail(401, 'Sign in with your account’s name and password.', challenge);

    const library = await libraries.backend(account.id).getLibrary();
    const answer = serveOpds(library, {
      path: url.pathname.slice(root.length + 1),
      query: url.searchParams,
      accept: req.headers.accept ?? '',
      root,
    });
    if (answer.status !== 200) return fail(answer.status, answer.message);

    // Answers differ by who's asking, so caches keep them to that one reader.
    const vary = 'Accept, Authorization, Cookie';
    if ('file' in answer) {
      const { hash, mediaType, name } = answer.file;
      const etag = `"${hash}"`;
      if (req.headers['if-none-match'] === etag) return done(304, { ETag: etag, Vary: vary });
      const object = await libraries.readFile(account.id, hash);
      if (!object) return fail(404, 'That file isn’t stored here.');
      res.writeHead(200, {
        'Content-Type': mediaType,
        'Content-Length': object.size,
        // Books carry HTML: nothing sent from them may run as this server's page.
        'Content-Security-Policy': "default-src 'none'; sandbox",
        ...(name && { 'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name)}` }),
        'Cache-Control': 'private, no-cache',
        ETag: etag,
        Vary: vary,
      });
      if (req.method === 'HEAD') {
        object.body.destroy();
        res.end();
        return false;
      }
      object.body.on('error', () => res.destroy()).pipe(res);
      return false;
    }

    const etag = `"${createHash('sha256').update(answer.body).digest('base64url').slice(0, 27)}"`;
    if (req.headers['if-none-match'] === etag) return done(304, { ETag: etag, Vary: vary });
    res.writeHead(200, {
      'Content-Type': `${answer.contentType}; charset=utf-8`,
      'Content-Length': Buffer.byteLength(answer.body),
      'Cache-Control': 'private, no-cache',
      ETag: etag,
      Vary: vary,
    });
    res.end(req.method === 'HEAD' ? undefined : answer.body);
    return false;
  };
}
