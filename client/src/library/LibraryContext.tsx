import {
  createMessageClient,
  storageApiMeta,
  fetchingMissingFiles,
  StoredLibraryBackend,
  type Library,
  type LibraryBackend,
  type Operation,
  type RpcSend,
} from '@nexlibris/common';
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { nativeTransport } from '../backends/native';
import { NativeStorage } from '../backends/nativeStorage';
import { OpfsStorage } from '../backends/opfsStorage';
import { Status } from '../styles/ui';
import { canSync, fetchFromHub } from '../sync/connect';

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
  const transport = nativeTransport();
  opening ??= (transport ? openNativeBackend(transport) : openOpfsBackend()).then((backend) =>
    // An instance that syncs with a hub may leave books' files there; they're fetched when read.
    canSync() ? fetchingMissingFiles(backend, (hash) => fetchFromHub(backend, hash)) : backend,
  );
  return opening;
}

/** In the Android or desktop app, the library lives in the app's own files, reached over estuary-rpc. */
async function openNativeBackend(transport: RpcSend): Promise<LibraryBackend> {
  const client = createMessageClient(storageApiMeta, transport);
  return new StoredLibraryBackend(new NativeStorage(client.storage));
}

async function openOpfsBackend(): Promise<LibraryBackend> {
  if (!navigator.storage?.getDirectory) {
    throw new Error('This browser does not support the Origin Private File System, which nexlibris needs to store your library.');
  }
  return new StoredLibraryBackend(await OpfsStorage.open('libraries', 'default'));
}

export function LibraryProvider({
  children,
  open = openBackend,
}: {
  children: ReactNode;
  /** How to get the backend; tests pass one in. */
  open?: () => Promise<LibraryBackend>;
}) {
  const [state, setState] = useState<State>({ status: 'loading' });

  useEffect(() => {
    let cancelled = false;
    open()
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
  }, [open]);

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
