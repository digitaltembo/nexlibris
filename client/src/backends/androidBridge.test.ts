import { createMessageClient, RpcStorage, storageApiMeta, type RpcMessage, type RpcResponse } from '@nexlibris/common';
import { afterEach, describe, expect, it } from 'vitest';
import { androidSend, type AndroidInterface } from './androidBridge';

/** Stands in for the app: answers each call later, by id, as JSON, like evaluateJavascript would. */
function fakeApp(answer: (message: RpcMessage) => RpcResponse): AndroidInterface & { received: RpcMessage[] } {
  const received: RpcMessage[] = [];
  return {
    received,
    call(json) {
      const message = JSON.parse(json) as RpcMessage;
      received.push(message);
      setTimeout(() => window.__nexlibrisBridge!.settle(message.id, JSON.stringify(answer(message))), 0);
    },
  };
}

afterEach(() => {
  delete window.__nexlibrisBridge;
});

describe('androidSend', () => {
  it('sends estuary-rpc requests and resolves with the answers, matched by id', async () => {
    const app = fakeApp(({ url, body }) => ({ ok: true, value: `${url}:${(body as { path: string }).path}` }));
    const client = createMessageClient(storageApiMeta, androidSend(app));
    const [a, b] = await Promise.all([client.storage.readText({ path: 'a' }), client.storage.readText({ path: 'b' })]);
    expect([a, b]).toEqual(['api/storage/readText:a', 'api/storage/readText:b']);
    expect(app.received).toEqual([
      { id: 1, method: 'GET', url: 'api/storage/readText', body: { path: 'a' } },
      { id: 2, method: 'GET', url: 'api/storage/readText', body: { path: 'b' } },
    ]);
  });

  it('rejects with the app’s error message', async () => {
    const app = fakeApp(() => ({ ok: false, message: 'Bad path: ../x' }));
    const storage = new RpcStorage(createMessageClient(storageApiMeta, androidSend(app)).storage);
    await expect(storage.readText('../x')).rejects.toThrow('Bad path: ../x');
  });

  it('rejects when the interface throws, and ignores answers for unknown calls', async () => {
    const send = androidSend({
      call() {
        throw new Error('bridge gone');
      },
    });
    await expect(send({ method: 'GET', url: 'api/storage/exists', body: { path: 'a' } })).rejects.toThrow('bridge gone');
    expect(() => window.__nexlibrisBridge!.settle(99, '{"ok":true,"value":1}')).not.toThrow();
  });
});
