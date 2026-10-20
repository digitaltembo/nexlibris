import { post, type SimpleMeta } from 'estuary-rpc';
import type { MessageClient } from './rpc';
import { DEFAULT_CHUNK_SIZE, fromBase64, toBase64 } from './rpcStorage';

/**
 * Calling a device on the local network (a CrossPoint reader's web server) from the Android or iOS app. Its
 * page is on a secure origin, so the web view won't let it call a reader's plain-http address; the app makes the
 * call instead. Only local addresses are called (`isLocalAddress`), and redirects aren't followed, so it
 * can't be used to reach anywhere else. Bodies cross the bridge in chunks: a request's is staged under a
 * token first, and a reply's comes back whole when small, else under a token to read. Android and iOS only: a
 * browser calls the device with `fetch` (`localFetch` in the client).
 */

export interface LocalHttpStageRequest {
  /** Names one body: letters, digits and dashes. */
  token: string;
  /** Base64. */
  data: string;
  /** Starts the body over, discarding anything staged under this token before. */
  first: boolean;
}

export interface LocalHttpRequest {
  /** E.g. `http://192.168.0.42/api/status`. */
  url: string;
  method: string;
  headers: [string, string][];
  /** The token of a body staged with `stage`, used up by the call. */
  body?: string;
}

export interface LocalHttpResponse {
  status: number;
  statusText: string;
  headers: [string, string][];
  size: number;
  /** The whole body, base64, when it's small. */
  data?: string;
  /** Otherwise, the token to `read` it by, until it's closed. */
  token?: string;
}

export const localHttpApiMeta = {
  localHttp: {
    stage: post<LocalHttpStageRequest, null, SimpleMeta>('api/localHttp/stage'),
    /** Makes the call; fails (with a message saying so) if the device can't be reached. */
    fetch: post<LocalHttpRequest, LocalHttpResponse, SimpleMeta>('api/localHttp/fetch'),
    /** Base64. */
    read: post<{ token: string; offset: number; length: number }, string, SimpleMeta>('api/localHttp/read'),
    close: post<{ token: string }, null, SimpleMeta>('api/localHttp/close'),
  },
};

export type LocalHttpApi = typeof localHttpApiMeta;

/**
 * Whether a URL is one the app calls for the page: http(s) to a private or link-local IPv4 address, IPv6
 * loopback, link-local or unique-local, a `.local` name or a name without dots, with no credentials in it.
 * As `LocalHttpService.isLocal` in the Android and iOS apps.
 */
export function isLocalAddress(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (!/^https?:$/.test(parsed.protocol) || parsed.username || parsed.password) return false;
  const host = parsed.hostname.toLowerCase();
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(host);
  if (ipv4) {
    const [a, b] = [Number(ipv4[1]), Number(ipv4[2])];
    return a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  }
  if (host.startsWith('[')) return /^\[(::1|fe[89ab][0-9a-f]?:.*|f[cd][0-9a-f]{0,2}:.*)\]$/.test(host);
  return /^[a-z0-9-]+(\.[a-z0-9-]+)*\.local$/.test(host) || /^[a-z0-9-]+$/.test(host);
}

/**
 * `fetch` over a remote {@link LocalHttpApi}: requests and replies as `fetch` makes and gives them. A device
 * that can't be reached fails with a `TypeError`, as `fetch` does, and an aborted request with its signal's reason.
 */
export function relayedFetch(api: MessageClient<LocalHttpApi>['localHttp'], chunkSize = DEFAULT_CHUNK_SIZE): typeof fetch {
  return async (input, init) => {
    const request = new Request(input, init);
    const signal = request.signal;
    const aborted = new Promise<never>((_, reject) => {
      if (signal.aborted) reject(signal.reason);
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
    // Unanswered until the call is made, so it never rejects unhandled.
    aborted.catch(() => undefined);
    const work = async () => {
      let body: string | undefined;
      if (request.body) {
        const blob = await request.blob();
        body = crypto.randomUUID();
        for (let offset = 0; offset === 0 || offset < blob.size; offset += chunkSize) {
          const bytes = new Uint8Array(await blob.slice(offset, offset + chunkSize).arrayBuffer());
          await api.stage({ token: body, data: toBase64(bytes), first: offset === 0 });
        }
      }
      let reply: LocalHttpResponse;
      try {
        reply = await api.fetch({ url: request.url, method: request.method, headers: [...request.headers], ...(body && { body }) });
      } catch (e) {
        throw new TypeError(e instanceof Error ? e.message : String(e));
      }
      let bytes: Uint8Array<ArrayBuffer>;
      if (reply.data !== undefined || !reply.token) {
        bytes = fromBase64(reply.data ?? '');
      } else {
        bytes = new Uint8Array(reply.size);
        try {
          for (let offset = 0; offset < reply.size; offset += chunkSize) {
            bytes.set(fromBase64(await api.read({ token: reply.token, offset, length: Math.min(chunkSize, reply.size - offset) })), offset);
          }
        } finally {
          await api.close({ token: reply.token }).catch(() => undefined);
        }
      }
      // A null body status (204, 304) can't have a body.
      const empty = reply.status === 204 || reply.status === 304 || request.method === 'HEAD';
      return new Response(empty ? null : bytes, { status: reply.status, statusText: reply.statusText, headers: reply.headers });
    };
    return Promise.race([work(), aborted]);
  };
}
