import { errorBody, SERVER_HEADER, SERVER_PROXY_PATH, serverAddress } from '@nexlibris/common';

/**
 * Passes the page's calls to the nexlibris server it chose on (see `common/src/appServer.ts`):
 * `app://nexlibris/server/<path>` with the server's address in `X-Nexlibris-Server` goes to
 * `<address>/<path>`. Only the call's own headers go, never cookies, and redirects aren't followed
 * (so the call can't end up anywhere else); a server that can't be reached is a 502, with an
 * estuary-rpc error body saying so.
 */

/** Whether an app URL is a call for the proxy. */
export const isServerCall = (url: string) => new URL(url).pathname.startsWith(SERVER_PROXY_PATH);

const FORWARDED = ['authorization', 'content-type', 'accept'];
const RETURNED = ['content-type', 'content-length', 'content-security-policy', 'etag', 'last-modified'];

const failure = (status: number, message: string) =>
  new Response(JSON.stringify(errorBody(message)), { status, headers: { 'Content-Type': 'application/json' } });

export async function proxyToServer(request: Request, fetchImpl: typeof fetch = (input, init) => fetch(input, init)): Promise<Response> {
  const base = serverAddress(request.headers.get(SERVER_HEADER) ?? '');
  if (!base) return failure(400, 'No nexlibris server address came with the call.');
  const url = new URL(request.url);
  const target = `${base}/${url.pathname.slice(SERVER_PROXY_PATH.length)}${url.search}`;
  const headers = new Headers();
  for (const name of FORWARDED) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  const hasBody = request.method !== 'GET' && request.method !== 'HEAD';
  let response: Response;
  try {
    response = await fetchImpl(target, {
      method: request.method,
      headers,
      redirect: 'manual',
      // Read whole: Electron's net.fetch doesn't take a streamed body everywhere, and uploads are a book at a time.
      ...(hasBody && { body: await request.arrayBuffer() }),
    });
  } catch {
    return failure(502, `Couldn’t reach the nexlibris server at ${base}. Check the address, and your connection.`);
  }
  if (response.status >= 300 && response.status < 400) {
    const to = response.headers.get('location');
    return failure(502, `${base} sent the call elsewhere${to ? ` (${to})` : ''}. Use the server’s address as it gives it, e.g. with https://.`);
  }
  const returned = new Headers();
  for (const name of RETURNED) {
    const value = response.headers.get(name);
    if (value) returned.set(name, value);
  }
  const empty = response.status === 204 || response.status === 304 || request.method === 'HEAD';
  return new Response(empty ? null : response.body, { status: response.status, statusText: response.statusText, headers: returned });
}
