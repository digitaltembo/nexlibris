/**
 * Calling an object's methods in a worker, as promises: `workerClient` in the page, `serveWorker`
 * in the worker. Arguments and results are structured-cloned (Blobs cheaply, by reference).
 */

/**
 * An object's methods as called across the boundary: each returns a promise. The proxies have no
 * `then`, so one can be awaited (or returned from an async function) as itself.
 */
export type Remote<T> = { [K in keyof T]: T[K] extends (...args: infer A) => infer R ? (...args: A) => Promise<Awaited<R>> : never };

type Request = { id: number; method: string; args: unknown[] };
type Reply = { id: number; result?: unknown; error?: string };

export function workerClient<T extends object>(worker: Worker): Remote<T> {
  let next = 0;
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  worker.addEventListener('message', (e: MessageEvent<Reply>) => {
    const call = pending.get(e.data.id);
    if (!call) return;
    pending.delete(e.data.id);
    if (e.data.error !== undefined) call.reject(new Error(e.data.error));
    else call.resolve(e.data.result);
  });
  // A worker that fails to load or crashes fails what's waiting on it, rather than leaving it hanging.
  worker.addEventListener('error', (e) => {
    for (const call of pending.values()) call.reject(new Error(e.message || 'The worker stopped.'));
    pending.clear();
  });
  return new Proxy({} as Remote<T>, {
    get: (_, method) =>
      method === 'then' ? undefined : (...args: unknown[]) =>
        new Promise((resolve, reject) => {
          const id = next++;
          pending.set(id, { resolve, reject });
          worker.postMessage({ id, method: String(method), args } satisfies Request);
        }),
  });
}

/** Answers `workerClient`'s calls with `api`'s methods. Call once, in the worker. */
export function serveWorker(api: object) {
  const scope = globalThis as unknown as { addEventListener(type: 'message', listener: (e: MessageEvent<Request>) => void): void; postMessage(reply: Reply): void };
  scope.addEventListener('message', async ({ data }) => {
    try {
      const method = (api as Record<string, (...args: unknown[]) => unknown>)[data.method];
      if (typeof method !== 'function') throw new Error(`No method ${data.method}`);
      scope.postMessage({ id: data.id, result: await method.apply(api, data.args) });
    } catch (e) {
      scope.postMessage({ id: data.id, error: e instanceof Error ? e.message : String(e) });
    }
  });
}

/** `api` itself, called as if across a worker: for where there are no workers (tests) or one couldn't start. */
export function inThread<T extends object>(api: T): Remote<T> {
  return new Proxy({} as Remote<T>, {
    get: (_, method) =>
      method === 'then' ? undefined : async (...args: unknown[]) =>
        (api as Record<string | symbol, (...args: unknown[]) => unknown>)[method]!.apply(api, args),
  });
}
