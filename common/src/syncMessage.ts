/**
 * Sync calls as messages over a link that carries small packets in order (Bluetooth, M6): an
 * HTTP-like request or response (`header` as JSON, then the body's bytes) split into chunks.
 * Requests mirror the hub's HTTP API, `POST api/sync/<endpoint>` with JSON and `GET`/`PUT
 * api/sync/files/<hash>` with the file's bytes, so the same client code runs over either.
 *
 * A message is `[header length: u32 little-endian][header: UTF-8 JSON][body]`. Each chunk is
 * `[flags: u8][part of the message]`, with flag `LAST_CHUNK` on a message's final chunk. One
 * message is in flight at a time each way (the client waits for each response), so chunks need
 * no ids. The Android app has the same framing (`BluetoothFraming.kt`); keep the two in step.
 */

export interface SyncMessageRequest {
  method: 'GET' | 'POST' | 'PUT';
  /** E.g. `api/sync/state`. */
  path: string;
  /** The pairing's key; none for `api/sync/pair`. */
  key?: string;
}

export interface SyncMessageResponse {
  status: number;
}

export const LAST_CHUNK = 1;

export function encodeMessage(header: object, body: Uint8Array = new Uint8Array()): Uint8Array<ArrayBuffer> {
  const head = new TextEncoder().encode(JSON.stringify(header));
  const message = new Uint8Array(4 + head.length + body.length);
  new DataView(message.buffer).setUint32(0, head.length, true);
  message.set(head, 4);
  message.set(body, 4 + head.length);
  return message;
}

export function decodeMessage<H>(message: Uint8Array): { header: H; body: Uint8Array<ArrayBuffer> } {
  if (message.length < 4) throw new Error('A sync message was cut short.');
  const length = new DataView(message.buffer, message.byteOffset, message.byteLength).getUint32(0, true);
  if (4 + length > message.length) throw new Error('A sync message was cut short.');
  const header = JSON.parse(new TextDecoder().decode(message.subarray(4, 4 + length))) as H;
  return { header, body: message.slice(4 + length) };
}

/** Splits a message into chunks of at most `size` bytes, flags included. */
export function chunkMessage(message: Uint8Array, size: number): Uint8Array<ArrayBuffer>[] {
  if (size < 2) throw new Error(`Chunks of ${size} bytes can't carry anything.`);
  const room = size - 1;
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  for (let offset = 0; offset === 0 || offset < message.length; offset += room) {
    const part = message.subarray(offset, offset + room);
    const chunk = new Uint8Array(1 + part.length);
    chunk[0] = offset + room >= message.length ? LAST_CHUNK : 0;
    chunk.set(part, 1);
    chunks.push(chunk);
  }
  return chunks;
}

/** Puts chunks back together: `push` returns the message once its last chunk is in. */
export class MessageAssembler {
  private parts: Uint8Array[] = [];
  private size = 0;

  push(chunk: Uint8Array): Uint8Array<ArrayBuffer> | undefined {
    if (chunk.length === 0) return undefined;
    this.parts.push(chunk.subarray(1));
    this.size += chunk.length - 1;
    if (!(chunk[0]! & LAST_CHUNK)) return undefined;
    const message = new Uint8Array(this.size);
    let offset = 0;
    for (const part of this.parts) {
      message.set(part, offset);
      offset += part.length;
    }
    this.reset();
    return message;
  }

  /** Drops a message part-way in, e.g. when the link drops. */
  reset() {
    this.parts = [];
    this.size = 0;
  }
}

/**
 * A `fetch` that makes each call as a message over `exchange` (one request message in, one
 * response message out), for `httpSend` and `httpHubFiles`. The URL's host is ignored: only its
 * path is sent, as the link already leads to the hub.
 */
export function messageFetch(exchange: (message: Uint8Array) => Promise<Uint8Array>): typeof fetch {
  return async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const method = (init?.method ?? 'GET').toUpperCase() as SyncMessageRequest['method'];
    const auth = new Headers(init?.headers).get('Authorization');
    const key = auth?.startsWith('Bearer ') ? auth.slice(7) : undefined;
    const body = init?.body == null ? new Uint8Array() : new Uint8Array(await new Response(init.body).arrayBuffer());
    const header: SyncMessageRequest = { method, path: url.pathname.replace(/^\/+/, ''), ...(key && { key }) };
    const reply = decodeMessage<SyncMessageResponse>(await exchange(encodeMessage(header, body)));
    return new Response(reply.body, { status: reply.header.status });
  };
}
