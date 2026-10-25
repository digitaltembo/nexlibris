import {
  httpSyncClient,
  pairingText,
  pairWithHub,
  parsePairingText,
  previewSync,
  removePairing,
  runSync,
  transferFiles,
  type BluetoothHostStatus,
  type FileProgress,
  type FileTransferResult,
  type FirstSyncMode,
  type NewPairing,
  type PairedPeer,
  type Pairing,
  type PairingCode,
  type Side,
  type SyncHostStatus,
  type SyncPreview,
  type SyncResult,
  type Device,
  type ItemId,
  type SyncOptions,
} from '@nexlibris/common';
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import styled from 'styled-components';
import { cameraAvailable, qrReader } from '../isbn/scanner';
import { useLibrary } from '../library/LibraryContext';
import { inIosApp } from '../backends/iosBridge';
import { inMobileApp } from '../backends/mobileBridge';
import { inDesktopApp } from '../backends/desktopBridge';
import { forgetFolder, saveFolder } from '../library/savedFolders';
import {
  BLUETOOTH_BASE,
  BLUETOOTH_PREFIX,
  canSyncOverBluetooth,
  chooseBluetoothHub,
  linkFetch,
  rememberLink,
  type BluetoothLink,
} from '../sync/bluetooth';
import { bluetoothHost, bluetoothSyncHub } from '../sync/bluetoothHost';
import { connectHub, describeAddress, transportOf, type HubConnection, type Transport } from '../sync/connect';
import { describeConflict } from '../sync/describe';
import {
  appFolderPath,
  canSyncThroughFolder,
  chooseAppFolder,
  chooseFolder,
  FOLDER_PREFIX,
  folderKey,
  openFolder,
} from '../sync/folder';
import { syncHost } from '../sync/hosting';
import { fileFetched } from '../sync/files';
import { addInstances, EVERY_BOOK, instanceScope, keptBy } from '../sync/instances';
import { catalogAdditions } from '../devices/selection';
import { canSyncOverNetwork, hubClient, instanceName, isOwnServer, ownServerClient } from '../sync/hub';
import { choosesServer, useServerSession } from '../library/account';
import { libraryPlace } from '../library/libraryFolder';
import { Button, Muted, Row, Spacer } from '../styles/ui';
import { CameraScanner } from './CameraScanner';
import { KeptBooks, PeerKeptBooks } from './KeptBooks';
import { Modal, ModalFooter } from './Modal';
import { QrCode } from './QrCode';
import { t, tn, type TextKey } from '../i18n';

const Section = styled.section`
  margin-top: 16px;

  h3 {
    margin: 0 0 4px;
    font-size: 1rem;
  }

  p {
    margin: 0 0 8px;
  }
`;

const ErrorText = styled.p`
  margin: 16px 0 0;
  color: var(--danger);
`;

const List = styled.ul`
  margin: 8px 0 0;
  padding: 0;
  list-style: none;

  li {
    display: flex;
    gap: 8px;
    align-items: baseline;
    padding: 6px 0;
    border-top: 1px solid var(--soft-border);
  }
`;

const Conflicts = styled.ul`
  margin: 8px 0 0;
  padding-left: 20px;
  max-height: 40vh;
  overflow: auto;
  font-size: 0.9rem;

  li {
    margin-bottom: 4px;
  }
`;

/** The ways to pair, which don't fit on one line in a dialog. */
const Choices = styled(Row)`
  flex-wrap: wrap;
`;

const Code = styled.code`
  font-size: 1.1rem;
  letter-spacing: 0.05em;
  user-select: all;
`;

const Form = styled.form`
  display: grid;
  gap: 8px;
  margin-top: 8px;

  label {
    display: grid;
    gap: 2px;
  }
`;

const errorMessage = (e: unknown) => (e instanceof Error ? e.message : String(e));
const when = (iso: string | undefined) => (iso ? new Date(iso).toLocaleString() : t('sync.never'));
const counted = (key: TextKey, count: number, vars: Record<string, string | number> = {}) => t(key, { ...vars, count, n: count });

/**
 * Sync between instances (M6), as connections (`ConnectionsDialog`): pairing with another
 * instance however this one can (over the network, over Bluetooth, through a folder), syncing
 * with one, and hosting (the desktop app on the network, the Android and iOS apps over Bluetooth).
 */

const TRANSPORT_LABEL: Record<Transport, TextKey> = {
  network: 'sync.transport.network',
  bluetooth: 'sync.transport.bluetooth',
  folder: 'sync.transport.folder',
};

/** How a paired instance is reached, for a connection's line, e.g. "over Bluetooth". */
export const transportLabel = (pairing: Pairing) => t(isOwnServer(pairing.address) ? 'sync.transport.account' : TRANSPORT_LABEL[transportOf(pairing.address)]);

/** How to pair: reaching another device as this one's hub, or (`host`) letting another reach this one. */
export type PairHow = 'network' | 'bluetooth' | 'folder' | 'server' | 'host';

/** Whether other devices can pair with this one as their hub: the desktop app on the network, the phone apps over Bluetooth. */
export const canHost = () => inDesktopApp() || inMobileApp();

/** The ways this instance can pair with another, for adding a connection. */
export function PairChoices({ onChoose }: { onChoose(how: PairHow): void }) {
  const session = useServerSession();
  // The account on this instance's server, unless the library is in it already.
  const account = !!session?.account && libraryPlace().kind !== 'cloud';
  const none = !account && !canSyncOverNetwork() && !canSyncOverBluetooth() && !canSyncThroughFolder();
  return (
    <Section>
      <Muted as="p">
        {t('sync.pairIntro')}
      </Muted>
      <Choices>
        {canHost() && (
          <Button $variant="secondary" onClick={() => onChoose('host')}>
            {inDesktopApp() ? t('sync.hostDesktop') : t('sync.hostPhone')}
          </Button>
        )}
        {account && (
          <Button $variant="secondary" onClick={() => onChoose('server')}>
            {t('sync.account', { name: session!.name })}
          </Button>
        )}
        {canSyncOverNetwork() && (
          <Button $variant="secondary" onClick={() => onChoose('network')}>
            {t('sync.network')}
          </Button>
        )}
        {canSyncOverBluetooth() && (
          <Button $variant="secondary" onClick={() => onChoose('bluetooth')}>
            {t('sync.bluetooth')}
          </Button>
        )}
        {canSyncThroughFolder() && (
          <Button $variant="secondary" onClick={() => onChoose('folder')}>
            {inIosApp() ? t('sync.folderIos') : inMobileApp() ? t('sync.folderPhone') : t('sync.folder')}
          </Button>
        )}
      </Choices>
      {none && !canHost() && (
        <Muted as="p">
          {t('sync.noWay')}
        </Muted>
      )}
    </Section>
  );
}

/** Pairing one way. */
export function PairScreen({ how, onPaired, onBack }: { how: PairHow } & PairProps) {
  if (how === 'host') {
    return (
      <>
        <Hosting />
        <BackFooter onBack={onBack} />
      </>
    );
  }
  if (how === 'network') return <PairNetwork onPaired={onPaired} onBack={onBack} />;
  if (how === 'bluetooth') return <PairBluetooth onPaired={onPaired} onBack={onBack} />;
  if (how === 'server') return <PairServer onPaired={onPaired} onBack={onBack} />;
  return <PairFolder onPaired={onPaired} onBack={onBack} />;
}

/**
 * Letting other devices pair with this one (Add connection → Nexlibris twin → Let a device pair…):
 * the desktop app on the network, the Android and iOS apps over Bluetooth. Turning it on, and a pairing code.
 * The devices paired are listed as connections (`useHostedPeers`), except those that haven't synced
 * yet, so have none, which are listed here.
 */
function Hosting() {
  const { library } = useLibrary();
  const listed = (origin: string) => !!library.devices?.[origin];
  if (inDesktopApp()) return <NetworkHosting listed={listed} />;
  if (inMobileApp()) return <BluetoothHosting listed={listed} />;
  return null;
}

/**
 * The devices paired with this one as their hub (the desktop app over the network, the phone apps
 * over Bluetooth), kept current while shown, and forgetting one. Empty where this one doesn't host.
 */
export function useHostedPeers(): { peers: PairedPeer[]; forget(origin: string): Promise<void> } {
  const [peers, setPeers] = useState<PairedPeer[]>([]);
  useEffect(() => {
    const read = inDesktopApp()
      ? async () => (await syncHost().status(null)).peers
      : inMobileApp()
        ? async () => (await bluetoothSyncHub()?.peers()) ?? []
        : undefined;
    if (!read) return;
    let cancelled = false;
    const load = () => void read().then((next) => !cancelled && setPeers(next), () => undefined);
    load();
    const timer = setInterval(load, 2000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);
  const forget = async (origin: string) => {
    if (inDesktopApp()) await syncHost().unpair({ origin });
    else await bluetoothSyncHub()?.unpair(origin);
    setPeers((all) => all.filter((p) => p.origin !== origin));
  };
  return { peers, forget };
}

/** The desktop app's side: turning sync on, showing a pairing code, and the paired devices. */
function NetworkHosting({ listed }: { listed(origin: string): boolean }) {
  const [status, setStatus] = useState<SyncHostStatus>();
  const [code, setCode] = useState<PairingCode>();
  const [error, setError] = useState<string>();
  /** When the status was last fetched, to tell when the code has expired. */
  const [checkedAt, setCheckedAt] = useState(0);
  /** How many devices were paired when the code was made, to see when one more is. */
  const pairedBefore = useRef(0);
  /** The books whose files the next device to pair keeps, carried by its code. */
  const [keep, setKeep] = useState(EVERY_BOOK);
  const newCode = (keepFiles: string) =>
    void run(async () => {
      pairedBefore.current = status?.peers.length ?? 0;
      setCode(await syncHost().newCode({ keepFiles }));
    });

  const run = async (task: () => Promise<SyncHostStatus | void>) => {
    setError(undefined);
    try {
      const next = await task();
      if (next) setStatus(next);
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  // Kept current while open: devices pair and sync while it's showing.
  useEffect(() => {
    const load = () =>
      syncHost()
        .status(null)
        .then(
          (next) => (setStatus(next), setCheckedAt(Date.now())),
          (e: unknown) => setError(errorMessage(e)),
        );
    void load();
    const timer = setInterval(() => void load(), 2000);
    return () => clearInterval(timer);
  }, []);
  // A code is done with once a device has used it, or it has expired (noticed at the next poll).
  const shownCode =
    code && (status?.peers.length ?? 0) <= pairedBefore.current && Date.parse(code.expiresAt) > checkedAt ? code : undefined;

  if (!status) return error ? <ErrorText>{error}</ErrorText> : <Muted as="p">{t('sync.loading')}</Muted>;
  const address = status.addresses[0];

  return (
    <>
      <Section>
        <h3>{t('sync.hostTitle')}</h3>
        <Muted as="p">
          {t('sync.hostExplain')}
        </Muted>
        <Row>
          <Button
            $variant={status.enabled ? 'secondary' : 'primary'}
            onClick={() => void run(() => syncHost().setEnabled({ enabled: !status.enabled }).finally(() => setCode(undefined)))}
          >
            {status.enabled ? t('sync.turnOff') : t('sync.turnOn')}
          </Button>
          {status.enabled && (
            <Button $variant="secondary" disabled={!address} onClick={() => newCode(keep)}>
              {t('sync.pairDevice')}
            </Button>
          )}
        </Row>
        {status.enabled && !address && !status.error && (
          <Muted as="p">{t('sync.noNetwork')}</Muted>
        )}
        {status.error && <ErrorText>{status.error}</ErrorText>}
      </Section>

      {shownCode && address && (
        <Section>
          <h3>{t('sync.pairTitle')}</h3>
          <Muted as="p">{t('sync.pairHow')}</Muted>
          <p>
            <KeptBooks
              name={t('sync.theDevice')}
              query={keep}
              onChange={(query) => {
                setKeep(query);
                newCode(query);
              }}
            />
          </p>
          <QrCode text={pairingText(address, shownCode.code)} label={t('sync.qrLabel', { code: shownCode.code, address })} />
          <p>
            <Code>{address}</Code>
            <br />
            <Code>{shownCode.code}</Code>
          </p>
          <Muted as="p">{t('sync.codeOnce')}</Muted>
        </Section>
      )}

      {status.peers.some((peer) => !listed(peer.origin)) && (
        <Section>
          {/* Those without a connection yet: the rest are listed as connections, with Forget there. */}
          <h3>{t('sync.notSyncedYet')}</h3>
          <List>
            {status.peers.filter((peer) => !listed(peer.origin)).map((peer) => (
              <li key={peer.origin}>
                <span>{peer.name}</span>
                <Muted>{t('sync.lastSynced', { when: when(peer.lastSyncedAt) })}</Muted>
                <Spacer />
                <Button $variant="secondary" $size="small" onClick={() => void run(() => syncHost().unpair({ origin: peer.origin }))}>
                  {t('sync.forget')}
                </Button>
                <PeerKeptBooks origin={peer.origin} name={peer.name} />
              </li>
            ))}
          </List>
        </Section>
      )}
      {error && <ErrorText>{error}</ErrorText>}
    </>
  );
}

type Step =
  | { kind: 'ready' }
  | { kind: 'previewing' }
  | { kind: 'preview'; preview: SyncPreview }
  | { kind: 'syncing'; preview: SyncPreview }
  | { kind: 'files'; result: SyncResult; progress?: FileProgress }
  | { kind: 'done'; result: SyncResult; files?: FileTransferResult; filesError?: string };

/**
 * Which way a sync goes: `from` brings the books the other instance shows this one (Sync from),
 * `to` sends the books in this one's catalog for it (Sync to), `both` does both. Books both have
 * merge either way, and nothing is deleted on either side.
 */
export type SyncDirection = 'both' | 'from' | 'to';

const DIRECTION_TITLE: Record<SyncDirection, TextKey> = { both: 'sync.direction.both', from: 'sync.direction.from', to: 'sync.direction.to' };

/** The sync's choices for a direction, or just some books (`only`). */
function directionOptions(direction: SyncDirection, only?: { pull?: ItemId[]; push?: ItemId[] }): Pick<SyncOptions, 'pull' | 'push'> {
  if (only) return { pull: only.pull ?? 'none', push: only.push ?? 'none' };
  return { pull: direction === 'to' ? 'none' : 'all', push: direction === 'from' ? 'none' : 'all' };
}

/**
 * Previewing and running syncs with a connected instance: Sync from, Sync to, or both ways, or
 * just some books (`only`: downloading one it shows this instance, or sending ones). Before it,
 * what this instance's catalog for it adds by search is added. Afterwards, the files of the books
 * that moved go with them, and those of books both have follow each side's catalog.
 */
export function SyncInstance({
  device,
  pairing: initial,
  start,
  direction: chosenDirection,
  only,
  self,
  onBack,
  onClose,
}: {
  device: Device;
  pairing: Pairing;
  start?: { first: FirstSyncMode };
  direction?: SyncDirection;
  only?: { pull?: ItemId[]; push?: ItemId[] };
  /** This instance's name, for its connection if the library hasn't one yet. */
  self: string;
  onBack(): void;
  onClose(): void;
}) {
  const { backend, refresh } = useLibrary();
  const [pairing, setPairing] = useState(initial);
  const [direction, setDirection] = useState<SyncDirection>(chosenDirection ?? 'both');
  // Opened to do something (just paired, Sync from or to, some books): it previews straight away.
  const auto = !!start || !!only || !!chosenDirection;
  const [step, setStep] = useState<Step>({ kind: auto ? 'previewing' : 'ready' });
  const [error, setError] = useState<string>();

  const preview = useCallback(
    async (options: { truth?: Side; first?: FirstSyncMode; direction?: SyncDirection } = {}) => {
      setError(undefined);
      setStep({ kind: 'previewing' });
      try {
        // First, as it may show the Bluetooth chooser or ask for the folder, which need the click.
        const { client } = await connectHub(pairing, backend, true);
        // What this instance's catalog for the hub adds by search, added for good.
        const library = await backend.getLibrary();
        const ours = library.devices?.[pairing.hub.origin];
        const additions = ours ? catalogAdditions(library, ours) : [];
        if (additions.length) await backend.apply(additions);
        const { direction: way = direction, ...rest } = options;
        const choices = directionOptions(way, only);
        setStep({ kind: 'preview', preview: await previewSync(backend, client, pairing, { ...rest, ...choices, expose: instanceScope }) });
      } catch (e) {
        setError(errorMessage(e));
        setStep({ kind: 'ready' });
      }
    },
    [backend, pairing, direction, only],
  );

  // Just paired, or asked to sync one way or some books: the hub is open already, or the click that asked is enough.
  const started = useRef(false);
  useEffect(() => {
    if (!auto || started.current) return;
    started.current = true;
    void preview(start ? { first: start.first } : {});
  }, [auto, start, preview]);

  const sync = async (ready: SyncPreview) => {
    setError(undefined);
    setStep({ kind: 'syncing', preview: ready });
    let result: SyncResult;
    let files: HubConnection['files'];
    try {
      const hub = await connectHub(pairing, backend, true);
      files = hub.files;
      result = await runSync(backend, hub.client, pairing, ready);
      // Both instances have connections, whatever the sync did (replacing this library drops this one's).
      const library = await backend.getLibrary();
      const missing = addInstances(library, [
        { origin: library.origin, name: self },
        { origin: pairing.hub.origin, name: device.name },
      ]);
      if (missing.length) await backend.apply(missing);
      await refresh();
    } catch (e) {
      await refresh();
      setError(t('sync.interrupted', { message: errorMessage(e) }));
      setStep({ kind: 'ready' });
      return;
    }
    // The libraries agree; now the files they refer to.
    setPairing(result.pairing);
    setStep({ kind: 'files', result });
    try {
      const library = await backend.getLibrary();
      // Books that moved bring their files; of books both have, each side's catalog says whose files go where.
      const pulled = new Set(result.pulled);
      const pushed = new Set(result.pushed);
      const shared = new Set(result.shared);
      const keptHere = keptBy(library, library.origin);
      const keptThere = keptBy(library, pairing.hub.origin);
      const choices = ready.first === 'replace' ? { pull: 'all', push: 'none' } : directionOptions(direction, only);
      const moved = await transferFiles(backend, files, {
        among: (item) => shared.has(item.id),
        keep: (item) => pulled.has(item.id) || (choices.pull !== 'none' && (keptHere?.(item) ?? true)),
        send: (item) => pushed.has(item.id) || (choices.push !== 'none' && (keptThere?.(item) ?? true)),
        onProgress: (progress) => setStep({ kind: 'files', result, progress }),
      });
      if (moved.downloaded) fileFetched();
      setStep({ kind: 'done', result, files: moved });
    } catch (e) {
      setStep({ kind: 'done', result, filesError: errorMessage(e) });
    }
  };

  const forget = async () => {
    await removePairing(backend, pairing.hub.origin);
    if (transportOf(pairing.address) === 'folder') await forgetFolder(folderKey(pairing.hub.origin)).catch(() => undefined);
    onBack();
  };

  const name = device.name;
  const throughFolder = transportOf(pairing.address) === 'folder';
  const busy = step.kind === 'previewing' || step.kind === 'syncing' || step.kind === 'files';

  return (
    <Modal title={t('sync.title', { direction: t(DIRECTION_TITLE[direction]), name })} onClose={busy ? () => undefined : onClose}>
      <Muted as="p">
        {t('sync.synced', { how: describeAddress(pairing.address), when: when(pairing.lastSyncedAt) })}
      </Muted>

      {step.kind === 'previewing' && <Muted as="p">{t('sync.comparing', { name })}</Muted>}

      {(step.kind === 'preview' || step.kind === 'syncing') && (
        <PreviewView
          preview={step.preview}
          hubName={name}
          busy={step.kind === 'syncing'}
          onTruth={(truth) => void preview({ truth, ...(step.preview.first && { first: step.preview.first }) })}
          onFirst={(mode) => void preview({ first: mode })}
        />
      )}

      {step.kind === 'files' && <FilesProgress progress={step.progress} hubName={name} />}

      {step.kind === 'done' && (
        <ResultView result={step.result} files={step.files} filesError={step.filesError} hubName={name} throughFolder={throughFolder} />
      )}

      {error && <ErrorText>{error}</ErrorText>}

      <ModalFooter>
        <Button $variant="secondary" disabled={busy} onClick={onBack}>
          {t('sync.back')}
        </Button>
        {(step.kind === 'ready' || step.kind === 'done') && (
          <Button $variant="secondary" onClick={() => void forget()} title={t('sync.unpairTitle')}>
            {t('sync.unpair')}
          </Button>
        )}
        <Spacer />
        {step.kind === 'ready' && (
          <>
            <Button
              $variant="secondary"
              title={t('sync.fromTitle', { name })}
              onClick={() => (setDirection('from'), void preview({ direction: 'from' }))}
            >
              {t('sync.syncFrom')}
            </Button>
            <Button
              $variant="secondary"
              title={t('sync.toTitle', { name })}
              onClick={() => (setDirection('to'), void preview({ direction: 'to' }))}
            >
              {t('sync.syncTo')}
            </Button>
            <Button onClick={() => (setDirection('both'), void preview({ direction: 'both' }))}>{t('sync.bothWays')}</Button>
          </>
        )}
        {(step.kind === 'preview' || step.kind === 'syncing') && (
          <>
            <Button $variant="secondary" disabled={step.kind === 'syncing'} onClick={() => setStep({ kind: 'ready' })}>
              {t('common.cancel')}
            </Button>
            <Button disabled={step.kind === 'syncing'} onClick={() => void sync(step.preview)}>
              {step.kind === 'syncing'
                ? t('sync.syncing')
                : only?.pull
                  ? t('sync.download')
                  : only?.push
                    ? t('sync.send')
                    : t(DIRECTION_TITLE[direction])}
            </Button>
          </>
        )}
        {step.kind === 'done' && <Button onClick={onClose}>{t('common.done')}</Button>}
      </ModalFooter>
    </Modal>
  );
}

export interface PairProps {
  /** With the books whose files the hub chose for this instance, if it did (`NewPairing.chosenFiles`). */
  onPaired(pairing: NewPairing, first?: FirstSyncMode): void;
  onBack(): void;
}

function BackFooter({ onBack, busy }: { onBack(): void; busy?: boolean }) {
  return (
    <ModalFooter>
      <Button $variant="secondary" disabled={busy} onClick={onBack}>
        {t('sync.back')}
      </Button>
    </ModalFooter>
  );
}

/** Pairing with a computer on the network (the desktop app hosting sync): by QR code, or its address and code. */
function PairNetwork({ onPaired, onBack }: PairProps) {
  const { backend, library } = useLibrary();
  const [scanning, setScanning] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [address, setAddress] = useState('');
  const [code, setCode] = useState('');
  const [first, setFirst] = useState<FirstSyncMode>('combine');

  const pair = async (hubAddress: string, pairingCode: string) => {
    setError(undefined);
    setBusy(true);
    const normalized = hubAddress.trim().replace(/\/$/, '');
    const withScheme = /^https?:\/\//.test(normalized) ? normalized : `http://${normalized}`;
    try {
      onPaired(await pairWithHub(backend, hubClient(withScheme), withScheme, pairingCode.trim(), instanceName()), first);
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    void pair(address, code);
  };

  return (
    <>
      <Section>
        <h3>{t('sync.pairComputer')}</h3>
        <Muted as="p">
          {t('sync.pairComputerHow')}
        </Muted>
        {scanning ? (
          <CameraScanner
            reader={qrReader}
            square
            hint={t('sync.qrHint')}
            otherwise={t('sync.qrOtherwise')}
            onError={(message) => (setError(message), setScanning(false))}
            onValue={(text) => {
              const parsed = parsePairingText(text);
              if (!parsed) return setError(t('sync.notPairingCode'));
              setScanning(false);
              void pair(parsed.address, parsed.code);
            }}
          />
        ) : (
          cameraAvailable() && (
            <Button disabled={busy} onClick={() => (setError(undefined), setScanning(true))}>
              {t('sync.scanQr')}
            </Button>
          )
        )}
        <Form onSubmit={submit}>
          <label>
            {t('sync.address')}
            <input value={address} onChange={(e) => setAddress(e.target.value)} placeholder="http://192.168.0.11:47811" inputMode="url" />
          </label>
          <label>
            {t('sync.code')}
            <input value={code} onChange={(e) => setCode(e.target.value)} placeholder="K3Q9-TX2M" autoCapitalize="characters" />
          </label>
          <Row>
            <Button type="submit" $variant="secondary" disabled={busy || !address.trim() || !code.trim()}>
              {busy ? t('sync.pairing') : t('sync.pair')}
            </Button>
          </Row>
        </Form>
      </Section>
      {Object.keys(library.items).length > 0 && <FirstSyncChoice value={first} onChange={setFirst} hub={t('sync.theComputer')} />}
      {error && <ErrorText>{error}</ErrorText>}
      <BackFooter onBack={onBack} busy={busy} />
    </>
  );
}

/**
 * Pairing with the account signed in on the server this page came from (M4), which keeps a copy
 * of the library that this one syncs with, as with another device. The session vouches for this
 * page, so there's no code.
 */
function PairServer({ onPaired, onBack }: PairProps) {
  const { backend, library } = useLibrary();
  const session = useServerSession();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [first, setFirst] = useState<FirstSyncMode>('combine');

  const pair = async () => {
    setError(undefined);
    setBusy(true);
    try {
      const { address, client } = ownServerClient();
      onPaired(await pairWithHub(backend, client, address, '', instanceName()), first);
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  };

  return (
    <>
      <Section>
        <h3>{t('sync.accountTitle')}</h3>
        <Muted as="p">
          {t('sync.accountExplain', {
            where: choosesServer() ? t('sync.onDevice') : t('sync.inBrowser'),
            account: session?.account ? t('sync.accountName', { name: session.account.name }) : '',
            server: session?.name ?? t('sync.thisServer'),
          })}
        </Muted>
        <Row>
          <Button $variant="primary" disabled={busy || !session?.account} onClick={() => void pair()}>
            {busy ? t('sync.connecting') : t('sync.connect')}
          </Button>
        </Row>
      </Section>
      {Object.keys(library.items).length > 0 && <FirstSyncChoice value={first} onChange={setFirst} hub={t('sync.yourAccount')} />}
      {error && <ErrorText>{error}</ErrorText>}
      <BackFooter onBack={onBack} busy={busy} />
    </>
  );
}

/** Pairing with a phone hosting sync over Bluetooth: choose it in the browser's chooser, then enter the code it shows. */
function PairBluetooth({ onPaired, onBack }: PairProps) {
  const { backend } = useLibrary();
  const [link, setLink] = useState<BluetoothLink>();
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const choose = async () => {
    setError(undefined);
    setBusy(true);
    try {
      link?.close();
      setLink(await chooseBluetoothHub());
    } catch (e) {
      setError(errorMessage(e));
    }
    setBusy(false);
  };
  const pair = async (e: FormEvent) => {
    e.preventDefault();
    if (!link) return;
    setError(undefined);
    setBusy(true);
    try {
      const client = httpSyncClient(BLUETOOTH_BASE, undefined, linkFetch(link));
      const pairing = await pairWithHub(backend, client, `${BLUETOOTH_PREFIX}${link.name}`, code.trim(), instanceName());
      rememberLink(pairing.hub.origin, link);
      onPaired(pairing);
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  };

  return (
    <>
      <Section>
        <h3>{t('sync.bluetoothTitle')}</h3>
        <Muted as="p">
          {t('sync.bluetoothHow')}
        </Muted>
        <Row>
          <Button $variant={link ? 'secondary' : 'primary'} disabled={busy} onClick={() => void choose()}>
            {link ? t('sync.anotherPhone') : t('sync.choosePhone')}
          </Button>
          {link && <Muted>{t('sync.connectedTo', { name: link.name })}</Muted>}
        </Row>
        {link && (
          <Form onSubmit={(e) => void pair(e)}>
            <label>
              {t('sync.codeOn', { name: link.name })}
              <input value={code} onChange={(e) => setCode(e.target.value)} placeholder="K3Q9-TX2M" autoCapitalize="characters" />
            </label>
            <Row>
              <Button type="submit" disabled={busy || !code.trim()}>
                {busy ? t('sync.pairing') : t('sync.pair')}
              </Button>
            </Row>
          </Form>
        )}
      </Section>
      {error && <ErrorText>{error}</ErrorText>}
      <BackFooter onBack={onBack} busy={busy} />
    </>
  );
}

/**
 * Pairing through a folder: in the Android app, a folder in the phone's storage, which a computer
 * sees over USB; in the iOS app, a folder picked in Files that the computer reaches too (iOS doesn't
 * show its folders to a computer over USB, so a drive carried between them, or iCloud Drive);
 * elsewhere a folder the user picks, such as that one on the plugged-in phone.
 */
function PairFolder({ onPaired, onBack }: PairProps) {
  const { backend } = useLibrary();
  /** The phone app's folder: undefined while finding out, null before one is chosen. */
  const [appPath, setAppPath] = useState<string | null>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (inMobileApp()) void appFolderPath().then(setAppPath, (e: unknown) => setError(errorMessage(e)));
  }, []);

  const chooseOnPhone = async () => {
    setError(undefined);
    setBusy(true);
    try {
      setAppPath(await chooseAppFolder());
    } catch (e) {
      setError(errorMessage(e));
    }
    setBusy(false);
  };

  const pair = async () => {
    setError(undefined);
    setBusy(true);
    try {
      const handle = inMobileApp() ? undefined : await chooseFolder();
      if (!inMobileApp() && !handle) return setBusy(false);
      const { hub } = openFolder(handle);
      const label = handle?.name ?? appPath ?? t('sync.syncFolder');
      const pairing = await pairWithHub(backend, hub.client, `${FOLDER_PREFIX}${label}`, '', instanceName());
      if (handle) await saveFolder(folderKey(pairing.hub.origin), handle);
      onPaired(pairing);
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  };

  return (
    <>
      <Section>
        {inIosApp() ? (
          <>
            <h3>{t('sync.iosTitle')}</h3>
            <Muted as="p">
              {t('sync.iosHow')}
            </Muted>
            {appPath && (
              <p>
                <Code>{appPath}</Code>
              </p>
            )}
            <Muted as="p">
              {t('sync.iosThen')}
            </Muted>
          </>
        ) : inMobileApp() ? (
          <>
            <h3>{t('sync.usbTitle')}</h3>
            <Muted as="p">
              {t('sync.usbHow')}
            </Muted>
            {appPath && (
              <p>
                <Code>{appPath}</Code>
              </p>
            )}
            <Muted as="p">
              {t('sync.usbThen')}
            </Muted>
          </>
        ) : (
          <>
            <h3>{t('sync.folderTitle')}</h3>
            <Muted as="p">
              {tn('sync.folderHow', { folder: <Code>{t('sync.folderExample')}</Code> })}
            </Muted>
            <Muted as="p">{t('sync.anyFolder')}</Muted>
          </>
        )}
        <Row>
          {inMobileApp() && (
            <Button $variant={appPath ? 'secondary' : 'primary'} disabled={busy || appPath === undefined} onClick={() => void chooseOnPhone()}>
              {appPath ? t('sync.anotherFolder') : t('sync.chooseFolder')}
            </Button>
          )}
          {(!inMobileApp() || appPath) && (
            <Button disabled={busy} onClick={() => void pair()}>
              {busy ? t('sync.pairing') : inMobileApp() ? t('sync.useFolder') : t('sync.chooseTheFolder')}
            </Button>
          )}
        </Row>
      </Section>
      {error && <ErrorText>{error}</ErrorText>}
      <BackFooter onBack={onBack} busy={busy} />
    </>
  );
}

/** The phone apps' side of Bluetooth: turning hosting on, showing a pairing code, and the paired devices. */
function BluetoothHosting({ listed }: { listed(origin: string): boolean }) {
  const [status, setStatus] = useState<BluetoothHostStatus>();
  const [peers, setPeers] = useState<PairedPeer[]>([]);
  const [code, setCode] = useState<PairingCode>();
  /** The books whose files the next device to pair keeps, carried by its code. */
  const [keep, setKeep] = useState(EVERY_BOOK);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  // Kept current while open: devices pair and sync while it's showing.
  useEffect(() => {
    const load = async () => {
      try {
        setStatus(await bluetoothHost().status(null));
        const hub = bluetoothSyncHub();
        if (hub) {
          setPeers(await hub.peers());
          if (!hub.codePending()) setCode(undefined);
        }
      } catch (e) {
        setError(errorMessage(e));
      }
    };
    void load();
    const timer = setInterval(() => void load(), 2000);
    return () => clearInterval(timer);
  }, []);

  const toggle = async () => {
    if (!status) return;
    setError(undefined);
    setBusy(true);
    try {
      setStatus(await bluetoothHost().setEnabled({ enabled: !status.enabled }));
      setCode(undefined);
    } catch (e) {
      setError(errorMessage(e));
    }
    setBusy(false);
  };

  return (
    <Section>
      <h3>{t('sync.btHostTitle')}</h3>
      <Muted as="p">
        {t('sync.btHostExplain')}
      </Muted>
      <Row>
        <Button $variant={status?.enabled ? 'secondary' : 'primary'} disabled={!status || busy} onClick={() => void toggle()}>
          {status?.enabled ? t('sync.turnOff') : t('sync.turnOn')}
        </Button>
        {status?.running && (
          <Button $variant="secondary" onClick={() => setCode(bluetoothSyncHub()?.newCode({ keepFiles: keep }))}>
            {t('sync.pairDevice')}
          </Button>
        )}
      </Row>
      {status?.running && (
        <Muted as="p">
          {status.name ? t('sync.onAs', { name: status.name }) : t('sync.on')}
          {status.connected > 0 && counted('sync.connected', status.connected)}
          {t('sync.end')}
        </Muted>
      )}
      {status?.enabled && !status.running && status.error && <ErrorText>{status.error}</ErrorText>}
      {code && (
        <>
          <Muted as="p">
            {t('sync.btPairHow', { phone: status?.name ? t('sync.quoted', { name: status.name }) : t('sync.thisPhone') })}
          </Muted>
          <p>
            <KeptBooks
              name={t('sync.theComputer')}
              query={keep}
              onChange={(query) => {
                setKeep(query);
                setCode(bluetoothSyncHub()?.newCode({ keepFiles: query }));
              }}
            />
          </p>
          <p>
            <Code>{code.code}</Code>
          </p>
          <Muted as="p">{t('sync.codeOnce')}</Muted>
        </>
      )}
      {peers.some((peer) => !listed(peer.origin)) && (
        <List>
          {peers.filter((peer) => !listed(peer.origin)).map((peer) => (
            <li key={peer.origin}>
              <span>{peer.name}</span>
              <Muted>{t('sync.lastSynced', { when: when(peer.lastSyncedAt) })}</Muted>
              <Spacer />
              <Button
                $variant="secondary"
                $size="small"
                onClick={() => void bluetoothSyncHub()?.unpair(peer.origin).then(() => setPeers((all) => all.filter((p) => p.origin !== peer.origin)))}
              >
                {t('sync.forget')}
              </Button>
              <PeerKeptBooks origin={peer.origin} name={peer.name} />
            </li>
          ))}
        </List>
      )}
      {error && <ErrorText>{error}</ErrorText>}
    </Section>
  );
}

function FirstSyncChoice({ value, onChange, hub }: { value: FirstSyncMode; onChange(mode: FirstSyncMode): void; hub: string }) {
  return (
    <Section>
      <h3>{t('sync.firstSync')}</h3>
      <label>
        <input type="radio" checked={value === 'combine'} onChange={() => onChange('combine')} /> {t('sync.combine', { hub })}
      </label>
      <br />
      <label>
        <input type="radio" checked={value === 'replace'} onChange={() => onChange('replace')} /> {t('sync.replace', { hub })}
      </label>
    </Section>
  );
}

function PreviewView({
  preview,
  hubName,
  busy,
  onTruth,
  onFirst,
}: {
  preview: SyncPreview;
  hubName: string;
  busy: boolean;
  onTruth(truth: Side): void;
  onFirst(mode: FirstSyncMode): void;
}) {
  const { plan, truth, first, libraries } = preview;
  const nothing = plan.ours.length === 0 && plan.theirs.length === 0;
  const titles = (ids: ItemId[], library: typeof libraries.ours) => ids.map((id) => library.items[id]?.title ?? id);
  const name = (side: Side) => (side === 'theirs' ? hubName : t('sync.thisDevice'));
  return (
    <>
      {first && Object.keys(libraries.ours.items).length > 0 && Object.keys(libraries.theirs.items).length > 0 && (
        <FirstSyncChoice value={first} onChange={(mode) => !busy && onFirst(mode)} hub={hubName} />
      )}
      <Section>
        <h3>{nothing ? t('sync.inSync') : t('sync.willChange')}</h3>
        {!nothing && (
          <Muted as="p">
            {t('sync.changeCounts', {
              ours: counted('sync.changes', plan.ours.length),
              theirs: counted('sync.changes', plan.theirs.length),
              hub: hubName,
            })}
          </Muted>
        )}
        {first === 'replace' && (
          <Muted as="p">{t('sync.becomesCopy', { hub: hubName })}</Muted>
        )}
        {first !== 'replace' && preview.pulled.length > 0 && (
          <Muted as="p">
            {tn('sync.brings', {
              books: counted('sync.books', preview.pulled.length),
              titles: <BookTitles titles={titles(preview.pulled, libraries.theirs)} />,
            })}
          </Muted>
        )}
        {preview.pushed.length > 0 && (
          <Muted as="p">
            {tn('sync.sends', {
              books: counted('sync.books', preview.pushed.length),
              hub: hubName,
              titles: <BookTitles titles={titles(preview.pushed, libraries.ours)} />,
            })}
          </Muted>
        )}
        {preview.offer.length > 0 && (
          <Muted as="p">
            {counted('sync.offered', preview.offer.length, { hub: hubName })}
          </Muted>
        )}
        {preview.keptOff && (
          <Muted as="p">
            {tn('sync.keptOff', { hub: hubName, titles: <BookTitles titles={titles(preview.keptOff, libraries.theirs)} /> })}
          </Muted>
        )}
        {preview.keptHere && (
          <Muted as="p">
            {tn('sync.keptHere', { hub: hubName, titles: <BookTitles titles={titles(preview.keptHere, libraries.ours)} /> })}
          </Muted>
        )}
      </Section>
      {first !== 'replace' && (
        <Section>
          <h3>{t('sync.disagree')}</h3>
          <label>
            <input type="radio" checked={truth === 'theirs'} disabled={busy} onChange={() => onTruth('theirs')} /> {t('sync.keepTheirs', { hub: hubName })}
          </label>{' '}
          <label>
            <input type="radio" checked={truth === 'ours'} disabled={busy} onChange={() => onTruth('ours')} /> {t('sync.keepOurs')}
          </label>
          {plan.conflicts.length === 0 ? (
            <Muted as="p">{t('sync.noConflicts')}</Muted>
          ) : (
            <Conflicts>
              {plan.conflicts.map((conflict, i) => {
                const view = describeConflict(conflict, libraries);
                return (
                  <li key={i}>
                    {tn('sync.conflict', {
                      what: <strong>{view.what}</strong>,
                      theirs: view.theirs,
                      hub: hubName,
                      theirsKept: conflict.winner === 'theirs' ? t('sync.kept') : '',
                      ours: view.ours,
                      oursKept: conflict.winner === 'ours' ? t('sync.kept') : '',
                    })}
                  </li>
                );
              })}
            </Conflicts>
          )}
          <Muted as="p">
            {t('sync.otherwise', { side: name(truth) })}
          </Muted>
        </Section>
      )}
    </>
  );
}

function FilesProgress({ progress, hubName }: { progress?: FileProgress; hubName: string }) {
  return (
    <Section>
      <h3>{t('sync.nowFiles')}</h3>
      <Muted as="p">
        {!progress
          ? t('sync.checkingFiles', { hub: hubName })
          : t(progress.direction === 'upload' ? 'sync.sendingFiles' : 'sync.fetchingFiles', {
              hub: hubName,
              done: progress.done,
              total: progress.total,
            })}
      </Muted>
      {progress?.direction === 'download' && progress.books !== undefined && (
        <Muted as="p">
          {t('sync.fetchCounts', {
            files: counted('sync.bookFiles', progress.books),
            covers: counted('sync.covers', progress.total - progress.books),
          })}
          {progress.notKept
            ? t('sync.notChosen', { files: counted('sync.bookFiles', progress.notKept), hub: hubName })
            : ''}
          {t('sync.end')}
        </Muted>
      )}
      {progress && <progress value={progress.done} max={Math.max(progress.total, 1)} />}
    </Section>
  );
}

/** Some books' titles, the first few, then how many more. */
function BookTitles({ titles }: { titles: string[] }) {
  const shown = titles.slice(0, 5);
  return (
    <>
      {shown.join(', ')}
      {titles.length > shown.length && t('sync.titlesMore', { count: titles.length - shown.length })}
      {t('sync.end')}
    </>
  );
}

function ResultView({
  result,
  files,
  filesError,
  hubName,
  throughFolder,
}: {
  result: SyncResult;
  files?: FileTransferResult;
  filesError?: string;
  hubName: string;
  throughFolder?: boolean;
}) {
  return (
    <Section>
      <h3>{t('sync.done')}</h3>
      <Muted as="p">
        {t('sync.resultChanges', {
          received: counted('sync.changes', result.received),
          sent: counted('sync.changes', result.sent),
          hub: hubName,
        })}
        {result.conflicts.length > 0 && counted('sync.disagreements', result.conflicts.length)}
        {result.pulled.length > 0 && counted('sync.broughtHere', result.pulled.length)}
        {result.pushed.length > 0 && counted('sync.booksSent', result.pushed.length)}
        {t('sync.end')}
      </Muted>
      {result.repaired.length > 0 && (
        <Muted as="p">
          {counted('sync.repaired', result.repaired.length)}
        </Muted>
      )}
      {files && (files.uploaded > 0 || files.downloaded > 0 || files.notKept > 0 || files.notSent > 0) && (
        <Muted as="p">
          {t('sync.fileCounts', {
            fetched: counted('sync.files', files.downloaded),
            sent: counted('sync.files', files.uploaded),
          })}
          {files.notKept > 0 &&
            t(throughFolder ? 'sync.notKeptHere' : 'sync.leftOn', {
              files: counted('sync.bookFileCount', files.notKept),
              hub: hubName,
            })}
          {files.notSent > 0 && t('sync.notSent', { files: counted('sync.bookFileCount', files.notSent), hub: hubName })}
          {t('sync.end')}
        </Muted>
      )}
      {files && files.unavailable > 0 && (
        <Muted as="p">
          {throughFolder
            ? counted('sync.unavailableFolder', files.unavailable)
            : counted('sync.unavailable', files.unavailable, { hub: hubName })}
        </Muted>
      )}
      {files && files.failed.length > 0 && (
        <ErrorText>
          {counted('sync.failed', files.failed.length, { message: files.failed[0]!.message })}
        </ErrorText>
      )}
      {filesError && <ErrorText>{t('sync.filesError', { message: filesError })}</ErrorText>}
    </Section>
  );
}
