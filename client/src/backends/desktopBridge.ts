import type { RpcRequest, RpcResponse, RpcSend } from '@nexlibris/common';

/** What the desktop app's preload (`desktop/src/preload.ts`) gives the page: one estuary-rpc call. */
export interface DesktopInterface {
  rpc(request: RpcRequest): Promise<RpcResponse>;
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
