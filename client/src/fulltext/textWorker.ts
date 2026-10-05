import type { TextWork } from './textWork';
import { inThread, workerClient, type Remote } from './workerRpc';

/** The text worker, or the same work in this thread where workers aren't available (tests). */
export async function startTextWork(): Promise<Remote<TextWork>> {
  if (typeof Worker !== 'undefined' && import.meta.env.MODE !== 'test') {
    try {
      return workerClient<TextWork>(new Worker(new URL('./text.worker.ts', import.meta.url), { type: 'module', name: 'text' }));
    } catch (e) {
      console.warn('The text worker didn’t start; indexing in the page', e);
    }
  }
  return inThread(new (await import('./textWork')).TextWork());
}
