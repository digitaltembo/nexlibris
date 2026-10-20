import { ApiError } from 'estuary-rpc';
import { createApiClient, type ClientOpts } from 'estuary-rpc-client';
import type { ApiMeta, MessageClient, RpcResponse } from './rpc';

/**
 * estuary-rpc APIs over HTTP (the M4 server's, and the sync API wherever a hub serves it), by
 * estuary-rpc's REST conventions: a reply is 200 with the response as JSON, or 204 for none; any
 * other status is an error, `{ status: 'error', message }`, which estuary-rpc-client throws as an
 * `ApiError` with the status. Clients are estuary-rpc-client's, over `fetch` (in the page, in Node,
 * over a Bluetooth link or the Android app's relay); hubs that pass calls on to the page rather than
 * running estuary-rpc-server (the desktop's, Bluetooth's) answer by the same conventions with
 * {@link restReply}.
 */

export { ApiError };

/** An estuary-rpc API's client over `fetch` (each endpoint called with just its request). */
export function httpClient<A extends ApiMeta>(api: A, options: ClientOpts): MessageClient<A> {
  return createApiClient(api, options) as unknown as MessageClient<A>;
}

/** A `fetch` that says `message` when the other side can't be reached at all, rather than the browser's "Failed to fetch". */
export function reaching(fetchImpl: typeof fetch, message: string): typeof fetch {
  return async (input, init) => {
    try {
      return await fetchImpl(input, init);
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') throw e;
      throw new Error(message);
    }
  };
}

/** Whether a call failed with this HTTP status (as estuary-rpc-client throws it). */
export const failedWith = (e: unknown, status: number): boolean => ApiError.is(e) && e.status === status;

/** estuary-rpc-server's error body. */
export interface ErrorBody {
  status: 'error';
  message: string;
}

export const errorBody = (message: string): ErrorBody => ({ status: 'error', message });

/**
 * A call answered over a message channel (`RpcResponse`), as estuary-rpc-server would answer it
 * over HTTP: for hubs that pass calls on to the page (the desktop's, Bluetooth's). An error is a
 * bad request, as estuary-rpc-server's `badRequest` makes it.
 */
export function restReply(response: RpcResponse): { status: number; body: string } {
  if (!response.ok) return { status: 400, body: JSON.stringify(errorBody(response.message)) };
  return response.value === null || response.value === undefined ? { status: 204, body: '' } : { status: 200, body: JSON.stringify(response.value) };
}
