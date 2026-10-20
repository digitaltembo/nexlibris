import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const desktop = vi.hoisted(() => ({ on: false }));
vi.mock('../backends/desktopBridge', () => ({ inDesktopApp: () => desktop.on }));
vi.mock('../backends/androidBridge', () => ({ inAndroidApp: () => false }));

import { chooseServer, forgetServer, serverSession, serverUrl, signIn, signOut } from './account';

const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });

describe('the desktop app’s server', () => {
  const calls: { url: string; headers: Headers }[] = [];

  beforeEach(() => {
    desktop.on = true;
    localStorage.clear();
    calls.length = 0;
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, headers: new Headers(init?.headers) });
      if (url.endsWith('/api/auth/sign-in')) return json({ name: 'Home', signup: false, account: { id: 'a', name: 'ada' }, token: 'secret' });
      if (url.endsWith('/api/auth/sign-out')) return json({ name: 'Home', signup: false });
      return json({ name: 'Home', signup: false, ...(new Headers(init?.headers).get('Authorization') && { account: { id: 'a', name: 'ada' } }) });
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    desktop.on = false;
  });

  it('is chosen by address, and called through the main process with the session’s token', async () => {
    await expect(chooseServer('ftp://x')).rejects.toThrow('isn’t a server’s address');
    expect((await chooseServer('192.168.1.20:8080/')).name).toBe('Home');
    expect(serverUrl()).toBe('http://192.168.1.20:8080');
    expect(calls[0]!.url).toBe(`${location.origin}/server/api/auth/session`);
    expect(calls[0]!.headers.get('X-Nexlibris-Server')).toBe('http://192.168.1.20:8080');

    const session = await signIn({ name: 'ada', password: 'pw' });
    expect(session.account?.name).toBe('ada');
    expect(session.token).toBeUndefined();
    expect(localStorage.getItem('nexlibris:server')).toContain('secret');

    await serverSession(true);
    expect(calls.at(-1)!.headers.get('Authorization')).toBe('Bearer secret');

    expect((await signOut())?.account).toBeUndefined();
    expect(localStorage.getItem('nexlibris:server')).not.toContain('secret');
    await forgetServer();
    expect(serverUrl()).toBeUndefined();
  });
});
