import { fetchingMissingFiles, type Library, type LibraryBackend, type Operation } from '@nexlibris/common';
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import styled from 'styled-components';
import { inAndroidApp } from '../backends/androidBridge';
import { nativeTransport } from '../backends/native';
import { Button, Status } from '../styles/ui';
import { canSync, fetchFromHub } from '../sync/connect';
import {
  FolderPermissionNeeded,
  forgetLibraryFolder,
  onLibraryMoved,
  openAndroidLibrary,
  openBrowserLibrary,
  openDesktopLibrary,
} from './libraryFolder';
import { mayWrite } from './savedFolders';

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
  | { status: 'permission'; folder: FileSystemDirectoryHandle }
  | { status: 'ready'; backend: LibraryBackend; library: Library };

let opening: Promise<LibraryBackend> | undefined;

/** Opens the backend once per page, even when effects run twice in StrictMode. */
function openBackend(): Promise<LibraryBackend> {
  const transport = nativeTransport();
  const native = transport && (inAndroidApp() ? Promise.resolve(openAndroidLibrary(transport)) : openDesktopLibrary(transport));
  opening ??= (native ?? openBrowserLibrary()).then((backend) =>
    // An instance that syncs with a hub may leave books' files there; they're fetched when read.
    canSync() ? fetchingMissingFiles(backend, (hash) => fetchFromHub(backend, hash)) : backend,
  );
  // Opening again (once a folder may be used, say) tries afresh.
  opening.catch(() => (opening = undefined));
  return opening;
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
  const [attempt, setAttempt] = useState(0);

  // Moved by another tab: open it where it is now.
  useEffect(() => (open === openBackend ? onLibraryMoved(() => location.reload()) : undefined), [open]);

  useEffect(() => {
    let cancelled = false;
    open()
      .then(async (backend) => {
        const library = await backend.getLibrary();
        if (!cancelled) setState({ status: 'ready', backend, library });
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        if (e instanceof FolderPermissionNeeded) setState({ status: 'permission', folder: e.folder });
        else setState({ status: 'error', message: e instanceof Error ? e.message : String(e) });
      });
    return () => {
      cancelled = true;
    };
  }, [open, attempt]);

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
  if (state.status === 'permission') {
    return (
      <FolderPermission
        folder={state.folder.name}
        onOpen={async () => {
          if (await mayWrite(state.folder)) setAttempt((n) => n + 1);
        }}
        onForget={async () => {
          await forgetLibraryFolder();
          setAttempt((n) => n + 1);
        }}
      />
    );
  }
  return (
    <LibraryContext.Provider value={{ backend: state.backend, library: state.library, apply, refresh }}>
      {children}
    </LibraryContext.Provider>
  );
}

/** Asking for the browser's permission to open the library's folder, which takes a click. */
export function FolderPermission({ folder, onOpen, onForget }: { folder: string; onOpen(): void; onForget(): void }) {
  return (
    <Asking>
      <p>
        Your library is in the folder <strong>{folder}</strong>. The browser asks again before nexlibris may use it; choose
        “Allow on every visit” to skip this next time.
      </p>
      <p>
        <Button $variant="primary" onClick={onOpen}>
          Open the library
        </Button>{' '}
        <Button onClick={onForget}>Use this browser’s storage instead</Button>
      </p>
    </Asking>
  );
}

const Asking = styled.div`
  max-width: 36rem;
  margin: 15vh auto 0;
  padding: 0 16px;
  line-height: 1.5;
`;
