import type { SessionInfo } from '@nexlibris/common';
import { useEffect, useState, type FormEvent } from 'react';
import styled from 'styled-components';
import {
  changePassword,
  chooseServer,
  chosenServer,
  choosesServer,
  forgetServer,
  onSessionChange,
  signIn,
  signOut,
  signUp,
  useServerState,
} from '../library/account';
import { libraryPlace, type LibraryPlace } from '../library/libraryFolder';
import { Button, Muted } from '../styles/ui';
import { Modal, ModalFooter } from './Modal';

const errorMessage = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Signing in to the server this page came from, or making an account where it allows. */
export function SignInForm({ session, onSignedIn }: { session: SessionInfo; onSignedIn(session: SessionInfo): void }) {
  const [making, setMaking] = useState(false);
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      onSignedIn(await (making ? signUp : signIn)({ name, password }));
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  };

  return (
    <Form onSubmit={(e) => void submit(e)}>
      <label>
        Name
        <input value={name} onChange={(e) => setName(e.target.value)} autoComplete="username" autoCapitalize="none" spellCheck={false} required />
      </label>
      <label>
        Password
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete={making ? 'new-password' : 'current-password'}
          minLength={making ? 8 : undefined}
          required
        />
      </label>
      <Actions>
        <Button type="submit" $variant="primary" disabled={busy || !name.trim() || !password}>
          {making ? 'Make the account' : 'Sign in'}
        </Button>
        {session.signup && (
          <Button $variant="secondary" disabled={busy} onClick={() => (setMaking(!making), setError(undefined))}>
            {making ? 'I have an account' : 'Make an account…'}
          </Button>
        )}
      </Actions>
      {error && <ErrorText role="alert">{error}</ErrorText>}
    </Form>
  );
}

/** Where the library is, from the account's side. */
function libraryLine(place: LibraryPlace, app: boolean): string {
  if (place.kind === 'cloud') return 'Your library is kept in your account, so it’s the same wherever you sign in.';
  const here = app ? 'on this device' : 'in this browser';
  return `Your library is kept ${here}. It can move to your account, or keep a copy there that it syncs with: see Library folder.`;
}

/**
 * The account on this instance's nexlibris server (M4): signing in or making one, and once signed
 * in, changing the password and signing out. In a browser the server is the one the page came
 * from; the apps choose one by its address (`ServerChoice`), for a server the user runs
 * themselves, say. Where the library is kept is the Library folder dialog's business; this says
 * where, and leads there.
 */
export function AccountDialog({
  onClose,
  onLibraryFolder,
  session: given,
  place = libraryPlace(),
  app = choosesServer(),
  server: givenServer,
  reachable,
}: {
  onClose(): void;
  onLibraryFolder?(): void;
  /** For stories: the session, rather than asking the server. */
  session?: SessionInfo;
  place?: LibraryPlace;
  /** Whether this instance chooses its server (the desktop and Android apps). */
  app?: boolean;
  /** For stories: the server an app has chosen, and whether it answered. */
  server?: string;
  reachable?: boolean;
}) {
  const { known, session: asked } = useServerState();
  const session = given ?? asked;
  const [server, setServer] = useState(() => givenServer ?? chosenServer());
  const [changing, setChanging] = useState(false);
  useEffect(() => onSessionChange(() => setServer(givenServer ?? chosenServer())), [givenServer]);
  const answered = reachable ?? (given !== undefined || known);

  return (
    <Modal title="Account" onClose={onClose}>
      {app && (
        <ServerChoice
          server={server}
          changing={changing || !server}
          signedIn={!!session?.account}
          onChange={() => setChanging(true)}
          onChosen={() => setChanging(false)}
          onCancel={server ? () => setChanging(false) : undefined}
        />
      )}
      {app && (!server || changing) ? null : !session ? (
        <Muted as="p">
          {answered && server ? `Couldn’t reach the server at ${server}. Check your connection, and the address.` : 'Asking the server…'}
        </Muted>
      ) : session.account ? (
        <SignedIn session={session} place={place} app={app} onLibraryFolder={onLibraryFolder} />
      ) : (
        <>
          <p>
            Sign in to {session.name} to keep your library in your account, where your other devices can reach it. Signed out,
            nexlibris keeps it {app ? 'on this device' : 'in this browser'}.
          </p>
          <SignInForm session={session} onSignedIn={() => undefined} />
        </>
      )}
      <ModalFooter>
        <Button $variant="secondary" onClick={onClose}>
          Close
        </Button>
      </ModalFooter>
    </Modal>
  );
}

/** In the apps: which nexlibris server to use, by its address. */
export function ServerChoice({
  server,
  changing,
  signedIn,
  onChange,
  onChosen,
  onCancel,
}: {
  server: string | undefined;
  changing: boolean;
  signedIn: boolean;
  onChange(): void;
  onChosen(): void;
  onCancel?: () => void;
}) {
  const [address, setAddress] = useState(server ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      await chooseServer(address);
      onChosen();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  if (!changing && server) {
    return (
      <ServerLine>
        <span>
          Server: <strong>{server}</strong>
        </span>
        <Button $variant="secondary" onClick={onChange}>
          Change…
        </Button>
        <Button $variant="secondary" disabled={busy} onClick={() => void forgetServer()}>
          {signedIn ? 'Sign out and stop using it' : 'Stop using it'}
        </Button>
      </ServerLine>
    );
  }
  return (
    <Form onSubmit={(e) => void submit(e)}>
      <Muted as="p">
        A nexlibris server keeps your library in an account, where your other devices can open it, or keeps a copy that this
        device syncs with. Run one yourself (see nexlibris’s README), or use one someone runs for you.
        {signedIn && ' Choosing another signs you out of this one.'}
      </Muted>
      <label>
        Server address
        <input
          value={address}
          onChange={(e) => setAddress(e.target.value)}
          placeholder="books.example.org or 192.168.1.20:8080"
          inputMode="url"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          required
        />
      </label>
      <Actions>
        <Button type="submit" $variant="primary" disabled={busy || !address.trim()}>
          {busy ? 'Connecting…' : 'Connect'}
        </Button>
        {onCancel && (
          <Button $variant="secondary" disabled={busy} onClick={onCancel}>
            Cancel
          </Button>
        )}
      </Actions>
      {error && <ErrorText role="alert">{error}</ErrorText>}
    </Form>
  );
}

function SignedIn({
  session,
  place,
  app,
  onLibraryFolder,
}: {
  session: SessionInfo;
  place: LibraryPlace;
  app: boolean;
  onLibraryFolder?: () => void;
}) {
  const [changing, setChanging] = useState(false);
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [status, setStatus] = useState<{ error?: string; done?: string }>({});
  const [busy, setBusy] = useState(false);

  const run = async (task: () => Promise<void>) => {
    setBusy(true);
    setStatus({});
    try {
      await task();
    } catch (e) {
      setStatus({ error: errorMessage(e) });
    } finally {
      setBusy(false);
    }
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      await changePassword(current, next);
      setChanging(false);
      setCurrent('');
      setNext('');
      setStatus({ done: 'Password changed. Your other devices are signed out.' });
    });
  };

  return (
    <>
      <p>
        Signed in to {session.name} as <strong>{session.account!.name}</strong>.
      </p>
      <p>
        <Muted>{libraryLine(place, app)}</Muted>
      </p>
      {changing ? (
        <Form onSubmit={submit}>
          <label>
            Current password
            <input type="password" value={current} onChange={(e) => setCurrent(e.target.value)} autoComplete="current-password" required />
          </label>
          <label>
            New password
            <input type="password" value={next} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" minLength={8} required />
          </label>
          <Actions>
            <Button type="submit" $variant="primary" disabled={busy || !current || next.length < 8}>
              Change it
            </Button>
            <Button $variant="secondary" disabled={busy} onClick={() => setChanging(false)}>
              Cancel
            </Button>
          </Actions>
        </Form>
      ) : (
        <Actions>
          {onLibraryFolder && (
            <Button $variant="secondary" onClick={onLibraryFolder}>
              Library folder…
            </Button>
          )}
          <Button $variant="secondary" onClick={() => setChanging(true)}>
            Change password…
          </Button>
          <Button $variant="secondary" disabled={busy} onClick={() => void run(async () => void (await signOut()))}>
            Sign out
          </Button>
        </Actions>
      )}
      {status.error && <ErrorText role="alert">{status.error}</ErrorText>}
      {status.done && <p role="status">{status.done}</p>}
    </>
  );
}

const ServerLine = styled.div`
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin-bottom: 12px;
  overflow-wrap: anywhere;
`;

const Form = styled.form`
  display: grid;
  gap: 8px;
  margin-top: 8px;
  max-width: 24rem;

  label {
    display: grid;
    gap: 2px;
  }
`;

const Actions = styled.div`
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 4px;
`;

const ErrorText = styled.p`
  margin: 8px 0 0;
  color: var(--danger);
`;
