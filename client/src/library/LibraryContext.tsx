import {
  createMessageClient,
  RpcStorage,
  storageApiMeta,
  StoredLibraryBackend,
  type Library,
  type LibraryBackend,
  type Operation,
} from '@nexlibris/common';
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { androidSend, inAndroidApp } from '../backends/androidBridge';
import { OpfsStorage } from '../backends/opfsStorage';
import { Status } from '../styles/ui';

interface LibraryContextValue {
  backend: LibraryBackend;
  library: Library;
  apply(ops: Operation[]): Promise<void>;
  /** Re-reads the library after something wrote to the backend directly. */
  refresh(): Promise<void>;
}

const LibraryContext = createContext<LibraryContextValue | undefined>(undefined);

export function useLibrary(): LibraryContextValue {
  const value = useContext(LibraryContext);
  if (!value) throw new Error('useLibrary must be used inside <LibraryProvider>');
  return value;
}

type State =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; backend: LibraryBackend; library: Library };

let opening: Promise<LibraryBackend> | undefined;

/** Opens the backend once per page, even when effects run twice in StrictMode. */
function openBackend(): Promise<LibraryBackend> {
  opening ??= inAndroidApp() ? openAndroidBackend() : openOpfsBackend();
  return opening;
}

/** In the Android app, the library lives in the app's own files, reached over estuary-rpc. */
async function openAndroidBackend(): Promise<LibraryBackend> {
  const client = createMessageClient(storageApiMeta, androidSend());
  return new StoredLibraryBackend(new RpcStorage(client.storage));
}

async function openOpfsBackend(): Promise<LibraryBackend> {
  if (!navigator.storage?.getDirectory) {
    throw new Error('This browser does not support the Origin Private File System, which nexlibris needs to store your library.');
  }
  return new StoredLibraryBackend(await OpfsStorage.open('libraries', 'default'));
}

export function LibraryProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<State>({ status: 'loading' });

  useEffect(() => {
    let cancelled = false;
    openBackend()
      .then(async (backend) => {
        const library = await backend.getLibrary();
        if (!cancelled) setState({ status: 'ready', backend, library });
      })
      .catch((e: unknown) => {
        if (!cancelled) setState({ status: 'error', message: e instanceof Error ? e.message : String(e) });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const backend = state.status === 'ready' ? state.backend : undefined;
  const apply = useCallback(
    async (ops: Operation[]) => {
      if (!backend) return;
      const library = await backend.apply(ops);
      setState({ status: 'ready', backend, library });
    },
    [backend],
  );
  const refresh = useCallback(async () => {
    if (!backend) return;
    setState({ status: 'ready', backend, library: await backend.getLibrary() });
  }, [backend]);

  if (state.status === 'loading') return <Status>Opening library…</Status>;
  if (state.status === 'error') return <Status $error>{state.message}</Status>;
  return (
    <LibraryContext.Provider value={{ backend: state.backend, library: state.library, apply, refresh }}>
      {children}
    </LibraryContext.Provider>
  );
}
