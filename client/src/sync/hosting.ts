import { libraryPlace } from '../library/libraryFolder';
import {
  createMessageClient,
  createMessageHandler,
  createSyncService,
  syncApiMeta,
  syncHostApiMeta,
  type LibraryBackend,
  type MessageImpl,
  type SyncApi,
} from '@nexlibris/common';
import { useEffect } from 'react';
import { desktopSend, inDesktopApp } from '../backends/desktopBridge';
import { instanceScope } from './instances';

export const syncHost = () => createMessageClient(syncHostApiMeta, desktopSend()).syncHost;

const handledByHost = async (): Promise<never> => {
  throw new Error('Handled by the desktop app itself');
};

/**
 * In the desktop app, answers the sync calls paired devices make, which its main process passes on
 * (only while sync is turned on there). The library and its backend are here, in the page, so this
 * is where they're answered; `refresh` shows what a sync changed.
 */
export function useSyncHosting(backend: LibraryBackend, refresh: () => Promise<void>) {
  useEffect(() => {
    const desktop = window.NexlibrisDesktop;
    // With the library in the account, the computer isn't a hub: the main process serves its own library's files.
    if (!inDesktopApp() || !desktop?.servePeers || libraryPlace().kind === 'cloud') return;
    let name = 'Computer';
    void syncHost()
      .status(null)
      .then((status) => (name = status.name))
      .catch(() => undefined);
    const service = createSyncService(backend, { name: () => name, onApplied: () => void refresh(), scope: instanceScope });
    const impl: MessageImpl<SyncApi> = { sync: { ...service, pair: handledByHost, done: handledByHost, missing: handledByHost } };
    const handle = createMessageHandler(syncApiMeta, impl);
    let id = 0;
    desktop.servePeers((request) => handle({ id: ++id, ...request }));
    return () => desktop.servePeers?.(undefined);
  }, [backend, refresh]);
}
