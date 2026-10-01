import { createMessageClient, RpcStorage, storageApiMeta, type RpcMessage, type RpcResponse } from '@nexlibris/common';
import { describe, expect, it } from 'vitest';
import { androidSend, type AndroidInterface, type BridgeReply } from './androidBridge';

/** Stands in for the app: answers each message later, by id, as the native bridge does. */
function fakeApp(answer: (message: RpcMessage) => RpcResponse): AndroidInterface & {
  received: RpcMessage[];
  reply(data: string): void;
} {
  const received: RpcMessage[] = [];
  const listeners: ((event: { data: string }) => void)[] = [];
  const reply = (data: string) => listeners.forEach((l) => l({ data }));
  return {
    received,
    reply,
    addEventListener: (_type, listener) => listeners.push(listener),
    postMessage(json) {
      const message = JSON.parse(json) as RpcMessage;
      received.push(message);
      const out: BridgeReply = { id: message.id, response: answer(message) };
      setTimeout(() => reply(JSON.stringify(out)), 0);
    },
  };
}

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

  it('rejects when posting throws, and ignores replies it can’t match', async () => {
    const app = fakeApp(() => ({ ok: true, value: null }));
    app.postMessage = () => {
      throw new Error('bridge gone');
    };
    const send = androidSend(app);
    await expect(send({ method: 'GET', url: 'api/storage/exists', body: { path: 'a' } })).rejects.toThrow('bridge gone');
    expect(() => app.reply('{"id":99,"response":{"ok":true,"value":1}}')).not.toThrow();
    expect(() => app.reply('not json')).not.toThrow();
  });
});
