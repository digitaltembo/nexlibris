import type { Api, SimpleMeta } from 'estuary-rpc';

/**
 * estuary-rpc over a message channel (such as an Android WebView's JavaScript
 * interface) instead of HTTP. Endpoints are identified by their URL, and requests
 * and responses are JSON, as with estuary-rpc's JSON transport.
 */

/** One endpoint call, as sent over the channel. */
export interface RpcRequest {
  method: string;
  url: string;
  body: unknown;
}

/** On the wire, a request carries an id that its response echoes back. */
export interface RpcMessage extends RpcRequest {
  id: number;
}

export type RpcResponse = { ok: true; value: unknown } | { ok: false; message: string };

export type RpcSend = (request: RpcRequest) => Promise<unknown>;

/** API metadata, as built with estuary-rpc's `get`, `post` and so on. */
export type ApiMeta = Api<unknown, SimpleMeta>;

/**
 * An API's callable form: each endpoint takes just its request (there's no
 * closure, unlike estuary-rpc-client's FetchOpts). The same shape serves as the
 * type of a TypeScript implementation.
 */
export type MessageClient<A> = {
  [K in keyof A]: A[K] extends (input: infer Req, closure: never) => Promise<infer Res>
    ? ((input: Req) => Promise<Res>) & SimpleMeta
    : MessageClient<A[K]>;
};

/** What implementing an API takes: a function per endpoint, nested the same way. */
export type MessageImpl<A> = {
  [K in keyof A]: A[K] extends (input: infer Req, closure: never) => Promise<infer Res>
    ? (input: Req) => Promise<Res>
    : MessageImpl<A[K]>;
};

const endpoints = (api: ApiMeta, visit: (meta: SimpleMeta, path: string[]) => void, path: string[] = []) => {
  for (const [key, value] of Object.entries(api)) {
    if (typeof value === 'function') visit(value as SimpleMeta, [...path, key]);
    else endpoints(value as ApiMeta, visit, [...path, key]);
  }
};

/** The client side: like estuary-rpc-client's `createApiClient`, but every call goes through `send`. */
export function createMessageClient<A extends ApiMeta>(api: A, send: RpcSend): MessageClient<A> {
  const client: Record<string, unknown> = {};
  endpoints(api, (meta, path) => {
    if (meta.method === 'WS' || !meta.url) throw new Error(`${path.join('.')}: only request/response endpoints work over messages`);
    let parent = client;
    for (const key of path.slice(0, -1)) parent = (parent[key] ??= {}) as Record<string, unknown>;
    const call = (body: unknown) => send({ method: meta.method ?? 'POST', url: meta.url!, body: body ?? null });
    parent[path.at(-1)!] = Object.assign(call, meta);
  });
  return client as MessageClient<A>;
}

/**
 * The serving side, for implementations written in TypeScript (the Android app implements
 * the same protocol natively): routes a request to the matching endpoint of `impl`.
 */
export function createMessageHandler<A extends ApiMeta>(
  api: A,
  impl: MessageImpl<A>,
): (message: RpcMessage) => Promise<RpcResponse> {
  const routes = new Map<string, (body: unknown) => Promise<unknown>>();
  endpoints(api, (meta, path) => {
    const fn = path.reduce<unknown>((node, key) => (node as Record<string, unknown>)[key], impl);
    routes.set(`${meta.method} ${meta.url}`, fn as (body: unknown) => Promise<unknown>);
  });
  return async ({ method, url, body }) => {
    const route = routes.get(`${method} ${url}`);
    if (!route) return { ok: false, message: `No endpoint for ${method} ${url}` };
    try {
      return { ok: true, value: (await route(body)) ?? null };
    } catch (e) {
      return { ok: false, message: e instanceof Error ? e.message : String(e) };
    }
  };
}
