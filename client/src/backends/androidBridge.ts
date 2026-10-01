import type { RpcMessage, RpcResponse, RpcSend } from '@nexlibris/common';

/**
 * The Android app's WebView JavaScript interface. Calls are fire-and-forget
 * strings (a JSON {@link RpcMessage}); the app answers each one later by calling
 * `window.__nexlibrisBridge.settle(id, responseJson)`.
 */
export interface AndroidInterface {
  call(message: string): void;
}

export interface BridgeReceiver {
  /** Called by the app with a JSON {@link RpcResponse}. */
  settle(id: number, response: string): void;
}

declare global {
  interface Window {
    NexlibrisAndroid?: AndroidInterface;
    __nexlibrisBridge?: BridgeReceiver;
  }
}

/** Whether this page is running inside the Android app. */
export const inAndroidApp = () => typeof window !== 'undefined' && window.NexlibrisAndroid !== undefined;

/** An estuary-rpc transport over the Android app's JavaScript interface. */
export function androidSend(native: AndroidInterface = window.NexlibrisAndroid!): RpcSend {
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  let nextId = 1;

  window.__nexlibrisBridge = {
    settle(id, response) {
      const call = pending.get(id);
      if (!call) return;
      pending.delete(id);
      try {
        const result = JSON.parse(response) as RpcResponse;
        if (result.ok) call.resolve(result.value);
        else call.reject(new Error(result.message));
      } catch (e) {
        call.reject(e instanceof Error ? e : new Error(String(e)));
      }
    },
  };

  return (request) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      const message: RpcMessage = { id, ...request };
      try {
        native.call(JSON.stringify(message));
      } catch (e) {
        pending.delete(id);
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
}
