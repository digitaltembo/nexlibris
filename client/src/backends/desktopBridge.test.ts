import { afterEach, describe, expect, it } from 'vitest';
import { desktopSend, followTitleBar, watchFullScreen, type DesktopInterface } from './desktopBridge';

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

const desktop = (titleBarInset: boolean) => {
  let fullScreen: ((on: boolean) => void) | undefined;
  const native: DesktopInterface = {
    rpc: async () => ({ ok: true, value: null }),
    titleBarInset,
    onFullScreen: (handler) => {
      fullScreen = handler;
    },
  };
  return { native, fullScreen: (on: boolean) => fullScreen?.(on) };
};

describe('followTitleBar', () => {
  afterEach(() => delete document.documentElement.dataset.titleBar);

  it('marks the page while the window buttons sit over it, but not in full screen', () => {
    const { native, fullScreen } = desktop(true);
    const stop = followTitleBar(native);
    expect(document.documentElement.dataset.titleBar).toBe('inset');
    fullScreen(true);
    expect(document.documentElement.dataset.titleBar).toBeUndefined();
    fullScreen(false);
    expect(document.documentElement.dataset.titleBar).toBe('inset');
    stop();
    expect(document.documentElement.dataset.titleBar).toBeUndefined();
  });

  it('leaves the page alone with a title bar, and outside the desktop app', () => {
    followTitleBar(desktop(false).native);
    followTitleBar(undefined);
    expect(document.documentElement.dataset.titleBar).toBeUndefined();
  });
});

describe('watchFullScreen', () => {
  it('tells everyone watching, until each stops', () => {
    let handler: ((on: boolean) => void) | undefined;
    const native: DesktopInterface = { rpc: async () => ({ ok: true, value: null }), onFullScreen: (h) => (handler = h) };
    const seen: string[] = [];
    const stopA = watchFullScreen((on) => seen.push(`a ${on}`), native);
    const stopB = watchFullScreen((on) => seen.push(`b ${on}`), native);
    handler?.(true);
    stopA();
    handler?.(false);
    expect(seen).toEqual(['a true', 'b true', 'b false']);
    stopB();
    expect(handler).toBeUndefined();
  });

  it('does nothing outside the desktop app', () => {
    expect(() => watchFullScreen(() => undefined, undefined)()).not.toThrow();
  });
});
