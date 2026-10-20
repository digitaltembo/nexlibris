import { describe, expect, it } from 'vitest';
import { serverAddress } from '@nexlibris/common';
import { isServerCall, proxyToServer } from './serverProxy';

const call = (path: string, init: RequestInit = {}, server = 'http://192.168.0.5:8080') =>
  new Request(`app://nexlibris/server/${path}`, { ...init, headers: { 'X-Nexlibris-Server': server, ...init.headers } });

describe('the server proxy', () => {
  it('passes a call on with its own headers only, and its reply back', async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      seen.push({ url, init });
      return new Response('{"ok":1}', { status: 200, headers: { 'Content-Type': 'application/json', 'Set-Cookie': 'a=b' } });
    }) as unknown as typeof fetch;
    const response = await proxyToServer(
      call('api/library/apply?x=1', {
        method: 'POST',
        body: '{"ops":[]}',
        headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json', Cookie: 'nexlibris_session=x', Origin: 'app://nexlibris' },
      }),
      fetchImpl,
    );
    expect(await response.text()).toBe('{"ok":1}');
    expect(response.headers.get('set-cookie')).toBeNull();
    expect(seen[0]!.url).toBe('http://192.168.0.5:8080/api/library/apply?x=1');
    const headers = seen[0]!.init.headers as Headers;
    expect([...headers.keys()].sort()).toEqual(['authorization', 'content-type']);
    expect(new TextDecoder().decode(seen[0]!.init.body as ArrayBuffer)).toBe('{"ops":[]}');
    expect(seen[0]!.init.redirect).toBe('manual');
  });

  it('keeps a server’s path, and says what went wrong', async () => {
    let url = '';
    const ok = (async (u: string) => ((url = u), new Response(null, { status: 204 }))) as unknown as typeof fetch;
    expect((await proxyToServer(call('api/auth/session', {}, 'https://example.org/books/'), ok)).status).toBe(204);
    expect(url).toBe('https://example.org/books/api/auth/session');

    const down = (async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    const unreachable = await proxyToServer(call('api/auth/session'), down);
    expect(unreachable.status).toBe(502);
    expect((await unreachable.json()).message).toContain('Couldn’t reach');

    const moved = (async () => new Response(null, { status: 301, headers: { Location: 'https://elsewhere.example/' } })) as unknown as typeof fetch;
    expect((await (await proxyToServer(call('api/auth/session'), moved)).json()).message).toContain('elsewhere.example');
    expect((await proxyToServer(call('api/auth/session', {}, 'ftp://x'), ok)).status).toBe(400);
  });

  it('knows its calls, and tidies typed addresses', () => {
    expect(isServerCall('app://nexlibris/server/api/x')).toBe(true);
    expect(isServerCall('app://nexlibris/assets/x.js')).toBe(false);
    expect(serverAddress('books.example.org')).toBe('https://books.example.org');
    expect(serverAddress('192.168.0.5:8080')).toBe('http://192.168.0.5:8080');
    expect(serverAddress(' http://192.168.0.5:8080/ ')).toBe('http://192.168.0.5:8080');
    expect(serverAddress('https://example.org/books/')).toBe('https://example.org/books');
    expect(serverAddress('https://user:pw@example.org')).toBeUndefined();
    expect(serverAddress('ftp://example.org')).toBeUndefined();
    expect(serverAddress('')).toBeUndefined();
  });
});
