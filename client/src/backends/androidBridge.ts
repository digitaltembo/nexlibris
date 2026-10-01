import type { RpcMessage, RpcResponse, RpcSend } from '@nexlibris/common';

/**
 * The Android app's bridge object (a WebView web message listener). Messages
 * are JSON {@link RpcMessage}s; the app answers each one later with a message
 * of its own, a JSON {@link BridgeReply}.
 */
export interface AndroidInterface {
  postMessage(message: string): void;
  addEventListener(type: 'message', listener: (event: { data: string }) => void): void;
}

export interface BridgeReply {
  id: number;
  response: RpcResponse;
}

declare global {
  interface Window {
    NexlibrisAndroid?: AndroidInterface;
  }
}

/** Whether this page is running inside the Android app. */
export const inAndroidApp = () => typeof window !== 'undefined' && window.NexlibrisAndroid !== undefined;

let shared: RpcSend | undefined;

/** The page's one transport to the app; separate transports would each number their calls from 1. */
export const androidTransport = (): RpcSend => (shared ??= androidSend());

/** An estuary-rpc transport over the Android app's bridge object. */
export function androidSend(native: AndroidInterface = window.NexlibrisAndroid!): RpcSend {
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  let nextId = 1;

  native.addEventListener('message', (event) => {
    let reply: BridgeReply;
    try {
      reply = JSON.parse(event.data) as BridgeReply;
    } catch {
      return;
    }
    const call = pending.get(reply.id);
    if (!call) return;
    pending.delete(reply.id);
    if (reply.response.ok) call.resolve(reply.response.value);
    else call.reject(new Error(reply.response.message));
  });

  return (request) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      const message: RpcMessage = { id, ...request };
      try {
        native.postMessage(JSON.stringify(message));
      } catch (e) {
        pending.delete(id);
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
}
