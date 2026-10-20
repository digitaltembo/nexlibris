import type { RpcRequest, RpcResponse, RpcSend } from '@nexlibris/common';

/**
 * The iOS app's bridge: a WKWebView script message handler with replies (`NativeBridge.swift`).
 * Each message is a JSON {@link RpcRequest}; the promise `postMessage` returns resolves with the
 * JSON {@link RpcResponse}, so calls need no ids of their own.
 */
export interface IosHandler {
  postMessage(message: string): Promise<unknown>;
}

declare global {
  interface Window {
    webkit?: { messageHandlers?: { nexlibris?: IosHandler } };
  }
}

/** Whether this page is running inside the iOS app. */
export const inIosApp = () => typeof window !== 'undefined' && window.webkit?.messageHandlers?.nexlibris !== undefined;

/** An estuary-rpc transport over the iOS app's message handler. */
export function iosSend(native: IosHandler = window.webkit!.messageHandlers!.nexlibris!): RpcSend {
  return async (request: RpcRequest) => {
    const reply = await native.postMessage(JSON.stringify(request));
    const response = JSON.parse(String(reply)) as RpcResponse;
    if (!response.ok) throw new Error(response.message);
    return response.value;
  };
}
