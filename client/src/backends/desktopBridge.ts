import type { NativeMenu, RpcRequest, RpcResponse, RpcSend } from '@nexlibris/common';

/** What the desktop app's preload (`desktop/src/preload.ts`) gives the page. */
export interface DesktopInterface {
  /** An estuary-rpc call to the main process. */
  rpc(request: RpcRequest): Promise<RpcResponse>;
  /** Answers sync calls from paired devices (see `sync/hosting.ts`); undefined stops answering. */
  servePeers?(handler: ((request: RpcRequest) => Promise<RpcResponse>) | undefined): void;
  /** Sets the menu bar's menus (see `common/src/nativeMenu.ts`). */
  setMenu?(menus: NativeMenu[]): void;
  /** Called with an item's id when it's chosen in the menu bar; undefined stops. */
  onMenuCommand?(handler: ((id: string) => void) | undefined): void;
  /** The window has no title bar, so its buttons sit over the page's top-left corner (macOS). */
  titleBarInset?: boolean;
  /** Called as the window enters or leaves full screen (where the window buttons hide); undefined stops. */
  onFullScreen?(handler: ((on: boolean) => void) | undefined): void;
  /** Puts the window in or out of full screen. */
  setFullScreen?(on: boolean): void;
}

declare global {
  interface Window {
    NexlibrisDesktop?: DesktopInterface;
  }
}

/** Whether this page is running inside the desktop (Electron) app. */
export const inDesktopApp = () => typeof window !== 'undefined' && window.NexlibrisDesktop !== undefined;

/** An estuary-rpc transport over the desktop app's IPC, which answers each call in turn. */
export function desktopSend(native: DesktopInterface = window.NexlibrisDesktop!): RpcSend {
  return async (request) => {
    const response = await native.rpc({ method: request.method, url: request.url, body: request.body });
    if (!response.ok) throw new Error(response.message);
    return response.value;
  };
}

/** Who follows full screen, per app: the preload takes one handler, which tells them all. */
const fullScreenWatchers = new WeakMap<DesktopInterface, Set<(on: boolean) => void>>();

/** Calls `watcher` as the window enters or leaves full screen. Returns a cleanup. */
export function watchFullScreen(
  watcher: (on: boolean) => void,
  native: DesktopInterface | undefined = window.NexlibrisDesktop,
): () => void {
  if (!native?.onFullScreen) return () => undefined;
  let watchers = fullScreenWatchers.get(native);
  if (!watchers) {
    const all = (watchers = new Set());
    fullScreenWatchers.set(native, all);
    native.onFullScreen((on) => all.forEach((each) => each(on)));
  }
  watchers.add(watcher);
  return () => {
    watchers.delete(watcher);
    if (watchers.size) return;
    fullScreenWatchers.delete(native);
    native.onFullScreen?.(undefined);
  };
}

/**
 * Marks the page while the desktop app's window buttons sit over it (`data-title-bar="inset"` on
 * `<html>`), so the top bar leaves room for them and moves the window (`styles/GlobalStyle.ts`).
 * Returns a cleanup.
 */
export function followTitleBar(native: DesktopInterface | undefined = window.NexlibrisDesktop): () => void {
  if (!native?.titleBarInset) return () => undefined;
  const root = document.documentElement;
  const set = (inset: boolean) => {
    if (inset) root.dataset.titleBar = 'inset';
    else delete root.dataset.titleBar;
  };
  set(true);
  const stop = watchFullScreen((on) => set(!on), native);
  return () => {
    stop();
    set(false);
  };
}
