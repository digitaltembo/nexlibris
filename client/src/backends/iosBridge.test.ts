import { createMessageClient, RpcStorage, storageApiMeta, type RpcRequest, type RpcResponse } from '@nexlibris/common';
import { describe, expect, it } from 'vitest';
import { iosSend, type IosHandler } from './iosBridge';

/** Stands in for the app: answers each message with a JSON response, as the message handler replies. */
function fakeApp(answer: (request: RpcRequest) => RpcResponse): IosHandler & { received: RpcRequest[] } {
  const received: RpcRequest[] = [];
  return {
    received,
    postMessage(json) {
      const request = JSON.parse(json) as RpcRequest;
      received.push(request);
      return new Promise((resolve) => setTimeout(() => resolve(JSON.stringify(answer(request))), 0));
    },
  };
}

describe('iosSend', () => {
  it('sends estuary-rpc requests and resolves with the answers', async () => {
    const app = fakeApp(({ url, body }) => ({ ok: true, value: `${url}:${(body as { path: string }).path}` }));
    const client = createMessageClient(storageApiMeta, iosSend(app));
    const [a, b] = await Promise.all([client.storage.readText({ path: 'a' }), client.storage.readText({ path: 'b' })]);
    expect([a, b]).toEqual(['api/storage/readText:a', 'api/storage/readText:b']);
    expect(app.received).toEqual([
      { method: 'GET', url: 'api/storage/readText', body: { path: 'a' } },
      { method: 'GET', url: 'api/storage/readText', body: { path: 'b' } },
    ]);
  });

  it('rejects with the app’s error message', async () => {
    const app = fakeApp(() => ({ ok: false, message: 'Bad path: ../x' }));
    const storage = new RpcStorage(createMessageClient(storageApiMeta, iosSend(app)).storage);
    await expect(storage.readText('../x')).rejects.toThrow('Bad path: ../x');
  });

  it('rejects when the app refuses the message', async () => {
    const send = iosSend({ postMessage: () => Promise.reject(new Error('Not allowed')) });
    await expect(send({ method: 'GET', url: 'api/storage/exists', body: { path: 'a' } })).rejects.toThrow('Not allowed');
  });
});
