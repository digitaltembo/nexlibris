import { describe, expect, it } from 'vitest';
import { isLocalAddress, localHttpApiMeta, relayedFetch, type LocalHttpApi, type LocalHttpRequest } from './localHttpApi';
import { createMessageClient, createMessageHandler, type MessageImpl, type RpcMessage, type RpcResponse } from './rpc';
import { fromBase64, toBase64 } from './rpcStorage';

/** The app's side, in memory: answers with `reply`, given each request and its staged body. */
function fakeApp(reply: (request: LocalHttpRequest, body: Uint8Array) => Response | Promise<Response>, inline = 4) {
  const staged = new Map<string, Uint8Array[]>();
  const replies = new Map<string, Uint8Array>();
  const calls: string[] = [];
  const impl: MessageImpl<LocalHttpApi>['localHttp'] = {
    stage: async ({ token, data, first }) => {
      calls.push('stage');
      staged.set(token, [...(first ? [] : staged.get(token)!), fromBase64(data)]);
      return null;
    },
    fetch: async (request) => {
      calls.push('fetch');
      if (!isLocalAddress(request.url)) throw new Error(`Not a local address: ${request.url}`);
      const parts = request.body ? staged.get(request.body)! : [];
      staged.delete(request.body ?? '');
      const body = new Uint8Array(await new Blob(parts as BlobPart[]).arrayBuffer());
      const response = await reply(request, body);
      const bytes = new Uint8Array(await response.arrayBuffer());
      const base = { status: response.status, statusText: response.statusText, headers: [...response.headers], size: bytes.length };
      if (bytes.length <= inline) return { ...base, data: toBase64(bytes) };
      const token = crypto.randomUUID();
      replies.set(token, bytes);
      return { ...base, token };
    },
    read: async ({ token, offset, length }) => {
      calls.push('read');
      return toBase64(replies.get(token)!.subarray(offset, offset + length));
    },
    close: async ({ token }) => {
      calls.push('close');
      replies.delete(token);
      return null;
    },
  };
  // Over the bridge, as JSON, as the app is called.
  const handle = createMessageHandler(localHttpApiMeta, { localHttp: impl });
  let id = 0;
  const api = createMessageClient(localHttpApiMeta, async (request) => {
    const response = JSON.parse(JSON.stringify(await handle({ id: ++id, ...request } as RpcMessage))) as RpcResponse;
    if (!response.ok) throw new Error(response.message);
    return response.value;
  }).localHttp;
  return { api, calls, replies };
}

describe('relayed fetch', () => {
  it('sends a form in chunks and reads a long reply in chunks', async () => {
    let seen: { request: LocalHttpRequest; body: string } | undefined;
    const app = fakeApp((request, body) => {
      seen = { request, body: new TextDecoder().decode(body) };
      return new Response('{"ok":"a long enough reply"}', { status: 201, headers: { 'Content-Type': 'application/json' } });
    });
    const form = new FormData();
    form.append('file', new File(['the book, as sent'], 'Dune.epub'));
    const response = await relayedFetch(app.api, 5)('http://192.168.0.42/upload?path=%2FBooks', { method: 'POST', body: form });

    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ ok: 'a long enough reply' });
    expect(seen!.request).toMatchObject({ url: 'http://192.168.0.42/upload?path=%2FBooks', method: 'POST' });
    expect(seen!.request.headers.find(([name]) => name === 'content-type')?.[1]).toMatch(/^multipart\/form-data; boundary=/);
    expect(seen!.body).toContain('filename="Dune.epub"');
    expect(seen!.body).toContain('the book, as sent');
    expect(app.calls.filter((c) => c === 'stage').length).toBeGreaterThan(1);
    expect(app.calls.filter((c) => c === 'read').length).toBeGreaterThan(1);
    expect(app.calls.at(-1)).toBe('close');
    expect(app.replies.size).toBe(0);
  });

  it('fails as fetch does when the app can’t make the call, and stops when aborted', async () => {
    const app = fakeApp(() => new Response('ok'));
    await expect(relayedFetch(app.api)('https://example.com/api/status')).rejects.toThrow(TypeError);

    const never = fakeApp(() => new Promise<Response>(() => undefined));
    const controller = new AbortController();
    const pending = relayedFetch(never.api)('http://crosspoint.local/api/status', { signal: controller.signal });
    controller.abort(new DOMException('Timed out', 'TimeoutError'));
    await expect(pending).rejects.toMatchObject({ name: 'TimeoutError' });
  });
});

describe('local addresses', () => {
  it('takes only the local network', () => {
    for (const url of [
      'http://192.168.0.42',
      'http://10.0.2.2:8080/api/files?path=%2F',
      'http://172.20.1.1',
      'http://169.254.3.4',
      'http://127.0.0.1:5173',
      'http://crosspoint.local/upload',
      'http://crosspoint',
      'http://[::1]:80',
      'http://[fe80::1]',
      'https://[fd00::2]',
    ]) {
      expect(isLocalAddress(url), url).toBe(true);
    }
    for (const url of [
      'http://example.com',
      'http://8.8.8.8',
      'http://172.32.0.1',
      'http://user:pw@192.168.0.2',
      'ftp://192.168.0.2',
      'file:///etc/passwd',
      'http://[2001:db8::1]',
      'not a url',
    ]) {
      expect(isLocalAddress(url), url).toBe(false);
    }
  });
});
