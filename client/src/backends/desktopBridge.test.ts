import { describe, expect, it } from 'vitest';
import { desktopSend } from './desktopBridge';

describe('desktopSend', () => {
  it('passes requests to the app and unwraps its answers', async () => {
    const sent: unknown[] = [];
    const send = desktopSend({
      rpc: async (request) => {
        sent.push(request);
        return request.url.endsWith('exists') ? { ok: true, value: true } : { ok: false, message: 'Bad path: ..' };
      },
    });
    expect(await send({ method: 'GET', url: 'api/storage/exists', body: { path: 'a' } })).toBe(true);
    await expect(send({ method: 'GET', url: 'api/storage/readText', body: { path: '..' } })).rejects.toThrow('Bad path: ..');
    expect(sent).toEqual([
      { method: 'GET', url: 'api/storage/exists', body: { path: 'a' } },
      { method: 'GET', url: 'api/storage/readText', body: { path: '..' } },
    ]);
  });
});
