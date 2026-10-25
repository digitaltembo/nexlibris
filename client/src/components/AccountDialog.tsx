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
import { t, tn } from '../i18n';

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
        {t('accountDialog.name')}
        <input value={name} onChange={(e) => setName(e.target.value)} autoComplete="username" autoCapitalize="none" spellCheck={false} required />
      </label>
      <label>
        {t('accountDialog.password')}
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
          {making ? t('accountDialog.make') : t('accountDialog.signIn')}
        </Button>
        {session.signup && (
          <Button $variant="secondary" disabled={busy} onClick={() => (setMaking(!making), setError(undefined))}>
            {making ? t('accountDialog.haveAccount') : t('accountDialog.makeAccount')}
          </Button>
        )}
      </Actions>
      {error && <ErrorText role="alert">{error}</ErrorText>}
    </Form>
  );
}

/** Where the library is, from the account's side. */
function libraryLine(place: LibraryPlace, app: boolean): string {
  if (place.kind === 'cloud') return t('accountDialog.cloud');
  return app ? t('accountDialog.device') : t('accountDialog.browser');
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
    <Modal title={t('accountDialog.title')} onClose={onClose}>
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
          {answered && server ? t('accountDialog.unreachable', { server }) : t('accountDialog.asking')}
        </Muted>
      ) : session.account ? (
        <SignedIn session={session} place={place} app={app} onLibraryFolder={onLibraryFolder} />
      ) : (
        <>
          <p>
            {t(app ? 'accountDialog.signInTo' : 'accountDialog.signInToBrowser', { name: session.name })}
          </p>
          <SignInForm session={session} onSignedIn={() => undefined} />
        </>
      )}
      <ModalFooter>
        <Button $variant="secondary" onClick={onClose}>
          {t('common.close')}
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
          {tn('accountDialog.server', { server: <strong>{server}</strong> })}
        </span>
        <Button $variant="secondary" onClick={onChange}>
          {t('accountDialog.change')}
        </Button>
        <Button $variant="secondary" disabled={busy} onClick={() => void forgetServer()}>
          {signedIn ? t('accountDialog.signOutStop') : t('accountDialog.stop')}
        </Button>
      </ServerLine>
    );
  }
  return (
    <Form onSubmit={(e) => void submit(e)}>
      <Muted as="p">
        {t('accountDialog.serverExplain')}
        {signedIn && t('accountDialog.signsOut')}
      </Muted>
      <label>
        {t('accountDialog.serverAddress')}
        <input
          value={address}
          onChange={(e) => setAddress(e.target.value)}
          placeholder={t('accountDialog.serverPlaceholder')}
          inputMode="url"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          required
        />
      </label>
      <Actions>
        <Button type="submit" $variant="primary" disabled={busy || !address.trim()}>
          {busy ? t('accountDialog.connecting') : t('accountDialog.connect')}
        </Button>
        {onCancel && (
          <Button $variant="secondary" disabled={busy} onClick={onCancel}>
            {t('common.cancel')}
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
      setStatus({ done: t('accountDialog.passwordChanged') });
    });
  };

  return (
    <>
      <p>
        {tn('accountDialog.signedInAs', { server: session.name, name: <strong>{session.account!.name}</strong> })}
      </p>
      <p>
        <Muted>{libraryLine(place, app)}</Muted>
      </p>
      {changing ? (
        <Form onSubmit={submit}>
          <label>
            {t('accountDialog.currentPassword')}
            <input type="password" value={current} onChange={(e) => setCurrent(e.target.value)} autoComplete="current-password" required />
          </label>
          <label>
            {t('accountDialog.newPassword')}
            <input type="password" value={next} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" minLength={8} required />
          </label>
          <Actions>
            <Button type="submit" $variant="primary" disabled={busy || !current || next.length < 8}>
              {t('accountDialog.changeIt')}
            </Button>
            <Button $variant="secondary" disabled={busy} onClick={() => setChanging(false)}>
              {t('common.cancel')}
            </Button>
          </Actions>
        </Form>
      ) : (
        <Actions>
          {onLibraryFolder && (
            <Button $variant="secondary" onClick={onLibraryFolder}>
              {t('accountDialog.libraryFolder')}
            </Button>
          )}
          <Button $variant="secondary" onClick={() => setChanging(true)}>
            {t('accountDialog.changePassword')}
          </Button>
          <Button $variant="secondary" disabled={busy} onClick={() => void run(async () => void (await signOut()))}>
            {t('accountDialog.signOut')}
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
