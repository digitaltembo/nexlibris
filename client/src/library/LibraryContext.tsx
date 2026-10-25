import { fetchingMissingFiles, isSignedOut, type Library, type LibraryBackend, type Operation, type SessionInfo } from '@nexlibris/common';
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import styled from 'styled-components';
import { mobileApp } from '../backends/mobileBridge';
import { nativeTransport } from '../backends/native';
import { Button, Status } from '../styles/ui';
import { SignInForm } from '../components/AccountDialog';
import { canSync, fetchFromHub } from '../sync/connect';
import { chosenServer, choosesServer, onSessionChange, serverSession, setWantsCloud, wantsCloud } from './account';
import {
  FolderPermissionNeeded,
  forgetLibraryFolder,
  libraryPlace,
  onLibraryMoved,
  openBrowserLibrary,
  openCloudLibrary,
  openNativeLibrary,
  SignInNeeded,
} from './libraryFolder';
import { mayWrite } from './savedFolders';
import { t, tn } from '../i18n';

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
  /** The library is in an account on the server, and nobody's signed in. */
  | { status: 'signIn'; session: SessionInfo | undefined }
  | { status: 'ready'; backend: LibraryBackend; library: Library };

let opening: Promise<LibraryBackend> | undefined;

/** Opens the backend once per page, even when effects run twice in StrictMode. */
function openBackend(): Promise<LibraryBackend> {
  const transport = nativeTransport();
  // The apps open their own library, unless it's to be the account's on their server.
  const native = transport && !wantsCloud() ? openNativeLibrary(transport, mobileApp() ?? 'desktop') : undefined;
  opening ??= (native ?? (wantsCloud() ? openCloudLibrary() : openBrowserLibrary())).then((backend) =>
    // An instance that syncs with a hub may leave books' files there; they're fetched when read. The account's has them all.
    canSync() && libraryPlace().kind !== 'cloud' ? fetchingMissingFiles(backend, (hash) => fetchFromHub(backend, hash)) : backend,
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
  // Signed out (here or in another tab) with the library in the account: it can't be shown any more.
  useEffect(
    () =>
      open === openBackend
        ? onSessionChange(() => {
            if (libraryPlace().kind !== 'cloud') return;
            void serverSession().then((session) => {
              if (!session?.account) setState({ status: 'signIn', session });
            });
          })
        : undefined,
    [open],
  );

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
        else if (e instanceof SignInNeeded) setState({ status: 'signIn', session: e.session });
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
      try {
        const library = await backend.apply(ops);
        setState({ status: 'ready', backend, library });
      } catch (e) {
        // The session ended: say so, rather than fail each change in turn.
        if (isSignedOut(e)) setState({ status: 'signIn', session: await serverSession(true) });
        throw e;
      }
    },
    [backend],
  );
  const refresh = useCallback(async () => {
    if (!backend) return;
    setState({ status: 'ready', backend, library: await backend.getLibrary() });
  }, [backend]);

  if (state.status === 'loading') return <Status>{t('libraryContext.opening')}</Status>;
  if (state.status === 'error') return <Status $error>{state.message}</Status>;
  if (state.status === 'signIn') {
    const retry = () => {
      opening = undefined;
      setState({ status: 'loading' });
      setAttempt((n) => n + 1);
    };
    return (
      <SignInScreen
        session={state.session}
        onSignedIn={retry}
        onUseBrowser={() => {
          setWantsCloud(false);
          retry();
        }}
      />
    );
  }
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

/** Signing in to open the library kept in the account, or using the browser's own storage instead. */
export function SignInScreen({ session, onSignedIn, onUseBrowser }: { session: SessionInfo | undefined; onSignedIn(): void; onUseBrowser(): void }) {
  const app = choosesServer();
  const server = app ? chosenServer() : undefined;
  return (
    <Asking>
      {session ? (
        <>
          <p>
            {t('libraryContext.signIn', { name: session.name, server: server ? t('libraryContext.server', { server }) : '' })}
          </p>
          <SignInForm session={session} onSignedIn={onSignedIn} />
        </>
      ) : (
        <p>
          {server
            ? t('libraryContext.unreachableServer', { server })
            : t('libraryContext.unreachable')}
        </p>
      )}
      <p>
        <Button onClick={onUseBrowser}>{app ? t('libraryContext.useDevice') : t('libraryContext.useBrowser')}</Button>
      </p>
    </Asking>
  );
}

/** Asking for the browser's permission to open the library's folder, which takes a click. */
export function FolderPermission({ folder, onOpen, onForget }: { folder: string; onOpen(): void; onForget(): void }) {
  return (
    <Asking>
      <p>
        {tn('libraryContext.folder', { folder: <strong>{folder}</strong> })}
      </p>
      <p>
        <Button $variant="primary" onClick={onOpen}>
          {t('libraryContext.open')}
        </Button>{' '}
        <Button onClick={onForget}>{t('libraryContext.useBrowser')}</Button>
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
