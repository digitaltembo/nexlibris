import {
  createMessageClient,
  httpSend,
  pairingText,
  pairWithHub,
  parsePairingText,
  previewSync,
  removePairing,
  runSync,
  syncApiMeta,
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
} from '@nexlibris/common';
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import styled from 'styled-components';
import { cameraAvailable, qrReader } from '../isbn/scanner';
import { useLibrary } from '../library/LibraryContext';
import { inAndroidApp } from '../backends/androidBridge';
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
import { formatSize } from './ItemFiles';
import {
  androidFolderPath,
  canSyncThroughFolder,
  chooseAndroidFolder,
  chooseFolder,
  FOLDER_PREFIX,
  folderKey,
  openFolder,
} from '../sync/folder';
import { syncHost } from '../sync/hosting';
import { fileFetched } from '../sync/files';
import { addInstances, EVERY_BOOK, keptBy, letGo, type LeftBooks } from '../sync/instances';
import { canSyncOverNetwork, hubClient, instanceName } from '../sync/hub';
import { Button, Muted, Row, Spacer } from '../styles/ui';
import { CameraScanner } from './CameraScanner';
import { KeptBooks, PeerKeptBooks } from './KeptBooks';
import { Modal, ModalFooter } from './Modal';
import { QrCode } from './QrCode';

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
const plural = (n: number, word: string, many = `${word}s`) => `${n} ${n === 1 ? word : many}`;
const when = (iso: string | undefined) => (iso ? new Date(iso).toLocaleString() : 'never');

/**
 * Sync between instances (M6), as connections (`ConnectionsDialog`): pairing with another
 * instance however this one can (over the network, over Bluetooth, through a folder), syncing
 * with one, and hosting (the desktop app on the network, the Android app over Bluetooth).
 */

const TRANSPORT_LABEL: Record<Transport, string> = { network: 'over the network', bluetooth: 'over Bluetooth', folder: 'through a folder' };

/** How a paired instance is reached, for a connection's line, e.g. "over Bluetooth". */
export const transportLabel = (pairing: Pairing) => TRANSPORT_LABEL[transportOf(pairing.address)];

export type PairHow = 'network' | 'bluetooth' | 'folder';

/** The ways this instance can pair with another, for adding a connection. */
export function PairChoices({ onChoose }: { onChoose(how: PairHow): void }) {
  const none = !canSyncOverNetwork() && !canSyncOverBluetooth() && !canSyncThroughFolder();
  return (
    <Section>
      <Muted as="p">
        Each device keeps the whole library, and syncs its changes with the ones it’s connected to. Books’ files go along too:
        the books chosen for each device, all of them to start with.
      </Muted>
      <Choices>
        {canSyncOverNetwork() && (
          <Button $variant="secondary" onClick={() => onChoose('network')}>
            A computer on this network…
          </Button>
        )}
        {canSyncOverBluetooth() && (
          <Button $variant="secondary" onClick={() => onChoose('bluetooth')}>
            A phone over Bluetooth…
          </Button>
        )}
        {canSyncThroughFolder() && (
          <Button $variant="secondary" onClick={() => onChoose('folder')}>
            {inAndroidApp() ? 'A computer by USB…' : 'A phone by USB, or a folder…'}
          </Button>
        )}
      </Choices>
      {none && (
        <Muted as="p">
          {inDesktopApp()
            ? 'Other devices connect to this one: turn on “Let other devices connect” below, then add this computer from them.'
            : 'This browser can’t reach other devices: use Chrome or Edge (over Bluetooth, or with a folder), or open nexlibris over plain http on the same network as the desktop app.'}
        </Muted>
      )}
    </Section>
  );
}

/** Pairing one way. */
export function PairScreen({ how, onPaired, onBack }: { how: PairHow } & PairProps) {
  if (how === 'network') return <PairNetwork onPaired={onPaired} onBack={onBack} />;
  if (how === 'bluetooth') return <PairBluetooth onPaired={onPaired} onBack={onBack} />;
  return <PairFolder onPaired={onPaired} onBack={onBack} />;
}

/** Letting other devices connect to this one: the desktop app on the network, the Android app over Bluetooth. */
export function Hosting() {
  if (inDesktopApp()) return <NetworkHosting />;
  if (inAndroidApp()) return <BluetoothHosting />;
  return null;
}

/** The desktop app's side: turning sync on, showing a pairing code, and the paired devices. */
function NetworkHosting() {
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

  if (!status) return error ? <ErrorText>{error}</ErrorText> : <Muted as="p">Loading…</Muted>;
  const address = status.addresses[0];

  return (
    <>
      <Section>
        <h3>Let other devices connect</h3>
        <Muted as="p">
          Lets the nexlibris app on your phone (or a browser on this network) sync with this library while nexlibris is
          open here. Each device needs pairing once.
        </Muted>
        <Row>
          <Button
            $variant={status.enabled ? 'secondary' : 'primary'}
            onClick={() => void run(() => syncHost().setEnabled({ enabled: !status.enabled }).finally(() => setCode(undefined)))}
          >
            {status.enabled ? 'Turn off' : 'Turn on'}
          </Button>
          {status.enabled && (
            <Button $variant="secondary" disabled={!address} onClick={() => newCode(keep)}>
              Pair a device…
            </Button>
          )}
        </Row>
        {status.enabled && !address && !status.error && (
          <Muted as="p">This computer isn’t on a network, so nothing can reach it.</Muted>
        )}
        {status.error && <ErrorText>{status.error}</ErrorText>}
      </Section>

      {shownCode && address && (
        <Section>
          <h3>Pair a device</h3>
          <Muted as="p">In nexlibris on the other device, add a connection to another nexlibris (“A computer on this network”), and scan this or enter the address and code.</Muted>
          <p>
            <KeptBooks
              name="the device"
              query={keep}
              onChange={(query) => {
                setKeep(query);
                newCode(query);
              }}
            />
          </p>
          <QrCode text={pairingText(address, shownCode.code)} label={`Pairing code ${shownCode.code} for ${address}`} />
          <p>
            <Code>{address}</Code>
            <br />
            <Code>{shownCode.code}</Code>
          </p>
          <Muted as="p">The code works once, for the next 10 minutes.</Muted>
        </Section>
      )}

      {status.peers.length > 0 && (
        <Section>
          <h3>Paired devices</h3>
          <List>
            {status.peers.map((peer) => (
              <li key={peer.origin}>
                <span>{peer.name}</span>
                <Muted>last synced {when(peer.lastSyncedAt)}</Muted>
                <Spacer />
                <Button $variant="secondary" $size="small" onClick={() => void run(() => syncHost().unpair({ origin: peer.origin }))}>
                  Forget
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
  | { kind: 'done'; result: SyncResult; files?: FileTransferResult; filesError?: string; left?: LeftBooks };



/**
 * Previewing and running syncs with a connected instance, as the connection's Sync. Afterwards,
 * each side's files follow its connection: the other instance gets the books chosen for it, and
 * this one fetches the books chosen for it.
 */
export function SyncInstance({
  device,
  pairing: initial,
  start,
  self,
  onBack,
  onClose,
}: {
  device: Device;
  pairing: Pairing;
  start?: { first: FirstSyncMode };
  /** This instance's name, for its connection if the library hasn't one yet. */
  self: string;
  onBack(): void;
  onClose(): void;
}) {
  const { backend, refresh } = useLibrary();
  const [pairing, setPairing] = useState(initial);
  const [step, setStep] = useState<Step>({ kind: start ? 'previewing' : 'ready' });
  const [error, setError] = useState<string>();

  const preview = useCallback(
    async (options: { truth?: Side; first?: FirstSyncMode } = {}) => {
      setError(undefined);
      setStep({ kind: 'previewing' });
      try {
        // First, as it may show the Bluetooth chooser or ask for the folder, which need the click.
        const { client } = await connectHub(pairing, backend, true);
        setStep({ kind: 'preview', preview: await previewSync(backend, client, pairing, options) });
      } catch (e) {
        setError(errorMessage(e));
        setStep({ kind: 'ready' });
      }
    },
    [backend, pairing],
  );

  // Just paired: the hub is open already, so no click is needed to reach it.
  const started = useRef(false);
  useEffect(() => {
    if (!start || started.current) return;
    started.current = true;
    void preview({ first: start.first });
  }, [start, preview]);

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
      setError(`${errorMessage(e)} Nothing is lost: sync again to finish.`);
      setStep({ kind: 'ready' });
      return;
    }
    // The libraries agree; now the files they refer to.
    setPairing(result.pairing);
    setStep({ kind: 'files', result });
    try {
      const library = await backend.getLibrary();
      const moved = await transferFiles(backend, files, {
        keep: keptBy(library, library.origin),
        send: keptBy(library, pairing.hub.origin),
        onProgress: (progress) => setStep({ kind: 'files', result, progress }),
      });
      if (moved.downloaded) fileFetched();
      const left = await letGo(backend, files, result);
      if (left) {
        setPairing(left.pairing);
        await refresh();
      }
      setStep({ kind: 'done', result, files: moved, ...(left && { left: left.left }) });
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
    <Modal title={`Sync ${name}`} onClose={busy ? () => undefined : onClose}>
      <Muted as="p">
        Synced {describeAddress(pairing.address)} · last synced {when(pairing.lastSyncedAt)}
      </Muted>

      {step.kind === 'previewing' && <Muted as="p">Comparing with {name}…</Muted>}

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
        <ResultView
          result={step.result}
          files={step.files}
          filesError={step.filesError}
          left={step.left}
          hubName={name}
          throughFolder={throughFolder}
        />
      )}

      {error && <ErrorText>{error}</ErrorText>}

      <ModalFooter>
        <Button $variant="secondary" disabled={busy} onClick={onBack}>
          Back
        </Button>
        {(step.kind === 'ready' || step.kind === 'done') && (
          <Button $variant="secondary" onClick={() => void forget()} title="Pair again to sync with it">
            Unpair
          </Button>
        )}
        <Spacer />
        {step.kind === 'ready' && <Button onClick={() => void preview()}>Sync now…</Button>}
        {(step.kind === 'preview' || step.kind === 'syncing') && (
          <>
            <Button $variant="secondary" disabled={step.kind === 'syncing'} onClick={() => setStep({ kind: 'ready' })}>
              Cancel
            </Button>
            <Button disabled={step.kind === 'syncing'} onClick={() => void sync(step.preview)}>
              {step.kind === 'syncing' ? 'Syncing…' : 'Sync'}
            </Button>
          </>
        )}
        {step.kind === 'done' && <Button onClick={onClose}>Done</Button>}
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
        Back
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
        <h3>Pair with a computer</h3>
        <Muted as="p">
          In nexlibris on your computer, open Connections, turn on “Let other devices connect” and choose “Pair a device”. Then scan the code it shows, or
          enter its address and code here.
        </Muted>
        {scanning ? (
          <CameraScanner
            reader={qrReader}
            square
            hint="Hold the QR code inside the frame."
            otherwise="Enter the address and code instead."
            onError={(message) => (setError(message), setScanning(false))}
            onValue={(text) => {
              const parsed = parsePairingText(text);
              if (!parsed) return setError('That QR code isn’t a nexlibris pairing code.');
              setScanning(false);
              void pair(parsed.address, parsed.code);
            }}
          />
        ) : (
          cameraAvailable() && (
            <Button disabled={busy} onClick={() => (setError(undefined), setScanning(true))}>
              Scan QR code
            </Button>
          )
        )}
        <Form onSubmit={submit}>
          <label>
            Address
            <input value={address} onChange={(e) => setAddress(e.target.value)} placeholder="http://192.168.0.11:47811" inputMode="url" />
          </label>
          <label>
            Code
            <input value={code} onChange={(e) => setCode(e.target.value)} placeholder="K3Q9-TX2M" autoCapitalize="characters" />
          </label>
          <Row>
            <Button type="submit" $variant="secondary" disabled={busy || !address.trim() || !code.trim()}>
              {busy ? 'Pairing…' : 'Pair'}
            </Button>
          </Row>
        </Form>
      </Section>
      {Object.keys(library.items).length > 0 && <FirstSyncChoice value={first} onChange={setFirst} hub="the computer" />}
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
      const client = createMessageClient(syncApiMeta, httpSend(BLUETOOTH_BASE, undefined, linkFetch(link))).sync;
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
        <h3>Pair with a phone over Bluetooth</h3>
        <Muted as="p">
          In nexlibris on your phone, open Connections, turn on “Let other devices connect over Bluetooth” and choose “Pair a device”. Then choose the
          phone here, and enter the code it shows. Syncing over Bluetooth is slow for books’ files: you can keep only some of
          them here, by editing this device’s connection.
        </Muted>
        <Row>
          <Button $variant={link ? 'secondary' : 'primary'} disabled={busy} onClick={() => void choose()}>
            {link ? 'Choose another phone…' : 'Choose the phone…'}
          </Button>
          {link && <Muted>Connected to {link.name}</Muted>}
        </Row>
        {link && (
          <Form onSubmit={(e) => void pair(e)}>
            <label>
              Code shown on {link.name}
              <input value={code} onChange={(e) => setCode(e.target.value)} placeholder="K3Q9-TX2M" autoCapitalize="characters" />
            </label>
            <Row>
              <Button type="submit" disabled={busy || !code.trim()}>
                {busy ? 'Pairing…' : 'Pair'}
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
 * sees over USB; elsewhere a folder the user picks, such as that one on the plugged-in phone.
 */
function PairFolder({ onPaired, onBack }: PairProps) {
  const { backend } = useLibrary();
  /** The Android app's folder: undefined while finding out, null before one is chosen. */
  const [androidPath, setAndroidPath] = useState<string | null>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (inAndroidApp()) void androidFolderPath().then(setAndroidPath, (e: unknown) => setError(errorMessage(e)));
  }, []);

  const chooseOnPhone = async () => {
    setError(undefined);
    setBusy(true);
    try {
      setAndroidPath(await chooseAndroidFolder());
    } catch (e) {
      setError(errorMessage(e));
    }
    setBusy(false);
  };

  const pair = async () => {
    setError(undefined);
    setBusy(true);
    try {
      const handle = inAndroidApp() ? undefined : await chooseFolder();
      if (!inAndroidApp() && !handle) return setBusy(false);
      const { hub } = openFolder(handle);
      const label = handle?.name ?? androidPath ?? 'sync folder';
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
        {inAndroidApp() ? (
          <>
            <h3>Sync with a computer by USB</h3>
            <Muted as="p">
              This phone syncs through a folder in its storage, which a computer can open when the phone is plugged in by
              USB. Make one for it (say, nexlibris-sync in Documents) and choose it.
            </Muted>
            {androidPath && (
              <p>
                <Code>{androidPath}</Code>
              </p>
            )}
            <Muted as="p">
              Sync here, plug the phone in, and in nexlibris on the computer add a connection to another nexlibris (“A phone by
              USB”) and choose that folder on the phone. Then sync here again to take what the computer sent. Books’ files are only kept in the folder until
              the other side has them.
            </Muted>
          </>
        ) : (
          <>
            <h3>Sync with a phone by USB, or through a folder</h3>
            <Muted as="p">
              Plug the phone in by USB, with its storage open on this computer (on a Mac that takes an app that mounts it,
              such as MacDroid), and choose the folder the phone syncs through (say <Code>Documents/nexlibris-sync</Code>).
              Sync on the phone before and after.
            </Muted>
            <Muted as="p">Any folder two devices both reach works the same way: a USB stick, or a shared or synced folder.</Muted>
          </>
        )}
        <Row>
          {inAndroidApp() && (
            <Button $variant={androidPath ? 'secondary' : 'primary'} disabled={busy || androidPath === undefined} onClick={() => void chooseOnPhone()}>
              {androidPath ? 'Choose another folder…' : 'Choose a folder…'}
            </Button>
          )}
          {(!inAndroidApp() || androidPath) && (
            <Button disabled={busy} onClick={() => void pair()}>
              {busy ? 'Pairing…' : inAndroidApp() ? 'Use this folder' : 'Choose the folder…'}
            </Button>
          )}
        </Row>
      </Section>
      {error && <ErrorText>{error}</ErrorText>}
      <BackFooter onBack={onBack} busy={busy} />
    </>
  );
}

/** The Android app's side of Bluetooth: turning hosting on, showing a pairing code, and the paired devices. */
function BluetoothHosting() {
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
      <h3>Let other devices connect over Bluetooth</h3>
      <Muted as="p">
        Lets a computer sync with this phone over Bluetooth while nexlibris is open here: in Chrome or Edge, or the desktop
        app, with no network needed.
      </Muted>
      <Row>
        <Button $variant={status?.enabled ? 'secondary' : 'primary'} disabled={!status || busy} onClick={() => void toggle()}>
          {status?.enabled ? 'Turn off' : 'Turn on'}
        </Button>
        {status?.running && (
          <Button $variant="secondary" onClick={() => setCode(bluetoothSyncHub()?.newCode({ keepFiles: keep }))}>
            Pair a device…
          </Button>
        )}
      </Row>
      {status?.running && (
        <Muted as="p">
          On{status.name && ` as “${status.name}”`}
          {status.connected > 0 && ` · ${plural(status.connected, 'device')} connected`}.
        </Muted>
      )}
      {status?.enabled && !status.running && status.error && <ErrorText>{status.error}</ErrorText>}
      {code && (
        <>
          <Muted as="p">
            On the computer, add a connection to another nexlibris (“A phone over Bluetooth”), choose {status?.name ? `“${status.name}”` : 'this phone'}, and enter:
          </Muted>
          <p>
            <KeptBooks
              name="the computer"
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
          <Muted as="p">The code works once, for the next 10 minutes.</Muted>
        </>
      )}
      {peers.length > 0 && (
        <List>
          {peers.map((peer) => (
            <li key={peer.origin}>
              <span>{peer.name}</span>
              <Muted>last synced {when(peer.lastSyncedAt)}</Muted>
              <Spacer />
              <Button
                $variant="secondary"
                $size="small"
                onClick={() => void bluetoothSyncHub()?.unpair(peer.origin).then(() => setPeers((all) => all.filter((p) => p.origin !== peer.origin)))}
              >
                Forget
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
      <h3>First sync</h3>
      <label>
        <input type="radio" checked={value === 'combine'} onChange={() => onChange('combine')} /> Combine this library with{' '}
        {hub}’s (a book in both shows up twice)
      </label>
      <br />
      <label>
        <input type="radio" checked={value === 'replace'} onChange={() => onChange('replace')} /> Replace this library with{' '}
        {hub}’s
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
  const name = (side: Side) => (side === 'theirs' ? hubName : 'this device');
  return (
    <>
      {first && Object.keys(libraries.ours.items).length > 0 && Object.keys(libraries.theirs.items).length > 0 && (
        <FirstSyncChoice value={first} onChange={(mode) => !busy && onFirst(mode)} hub={hubName} />
      )}
      <Section>
        <h3>{nothing ? 'Already in sync' : 'What will change'}</h3>
        {!nothing && (
          <Muted as="p">
            {plural(plan.ours.length, 'change')} from {hubName} to apply here, {plural(plan.theirs.length, 'change')} to send to it.
          </Muted>
        )}
        {first === 'replace' && (
          <Muted as="p">This library will become a copy of {hubName}’s: books only here are removed.</Muted>
        )}
      </Section>
      {first !== 'replace' && (
        <Section>
          <h3>Where they disagree</h3>
          <label>
            <input type="radio" checked={truth === 'theirs'} disabled={busy} onChange={() => onTruth('theirs')} /> Keep {hubName}’s
          </label>{' '}
          <label>
            <input type="radio" checked={truth === 'ours'} disabled={busy} onChange={() => onTruth('ours')} /> Keep this device’s
          </label>
          {plan.conflicts.length === 0 ? (
            <Muted as="p">Nothing was changed differently on both.</Muted>
          ) : (
            <Conflicts>
              {plan.conflicts.map((conflict, i) => {
                const view = describeConflict(conflict, libraries);
                return (
                  <li key={i}>
                    <strong>{view.what}</strong>: {view.theirs} ({hubName}
                    {conflict.winner === 'theirs' ? ', kept' : ''}) / {view.ours} (this device
                    {conflict.winner === 'ours' ? ', kept' : ''})
                  </li>
                );
              })}
            </Conflicts>
          )}
          <Muted as="p">
            Otherwise {name(truth)} wins, except for reading positions: they keep whichever is newer.
          </Muted>
        </Section>
      )}
    </>
  );
}

function FilesProgress({ progress, hubName }: { progress?: FileProgress; hubName: string }) {
  return (
    <Section>
      <h3>Synced; now the files</h3>
      <Muted as="p">
        {!progress
          ? `Checking which files ${hubName} needs…`
          : progress.direction === 'upload'
            ? `Sending files to ${hubName}: ${progress.done} of ${progress.total}`
            : `Fetching files from ${hubName}: ${progress.done} of ${progress.total}`}
      </Muted>
      {progress?.direction === 'download' && progress.books !== undefined && (
        <Muted as="p">
          {plural(progress.books, 'book’s file', 'books’ files')} and {plural(progress.total - progress.books, 'cover')}
          {progress.notKept ? `; ${plural(progress.notKept, 'book’s file', 'books’ files')} not chosen for here, left on ${hubName} until opened` : ''}.
        </Muted>
      )}
      {progress && <progress value={progress.done} max={Math.max(progress.total, 1)} />}
    </Section>
  );
}

function ResultView({
  result,
  files,
  filesError,
  left,
  hubName,
  throughFolder,
}: {
  result: SyncResult;
  files?: FileTransferResult;
  filesError?: string;
  left?: LeftBooks;
  hubName: string;
  throughFolder?: boolean;
}) {
  return (
    <Section>
      <h3>Synced</h3>
      <Muted as="p">
        {plural(result.received, 'change')} from {hubName}, {plural(result.sent, 'change')} sent
        {result.conflicts.length > 0 && `, ${plural(result.conflicts.length, 'disagreement')} settled`}.
      </Muted>
      {result.repaired.length > 0 && (
        <Muted as="p">
          The check afterwards found {plural(result.repaired.length, 'item')} that still differed, and copied them from the
          source of truth.
        </Muted>
      )}
      {files && (files.uploaded > 0 || files.downloaded > 0 || files.notKept > 0 || files.notSent > 0) && (
        <Muted as="p">
          {plural(files.downloaded, 'file')} fetched, {plural(files.uploaded, 'file')} sent
          {files.notKept > 0 &&
            (throughFolder
              ? `; ${plural(files.notKept, 'book file')} not kept here`
              : `; ${plural(files.notKept, 'book file')} left on ${hubName} until opened`)}
          {files.notSent > 0 && `; ${plural(files.notSent, 'book file')} not chosen for ${hubName}, so kept only here`}
          .
        </Muted>
      )}
      {files && files.unavailable > 0 && (
        <Muted as="p">
          {throughFolder
            ? `${plural(files.unavailable, 'file')} aren’t in the folder yet: the device that has them adds them when it next syncs there. Sync here again after that.`
            : `${plural(files.unavailable, 'file')} aren’t on ${hubName} yet: another device has them and hasn’t synced since. They’ll come on a later sync.`}
        </Muted>
      )}
      {files && files.failed.length > 0 && (
        <ErrorText>
          {plural(files.failed.length, 'file')} couldn’t be moved ({files.failed[0]!.message}). Sync again to retry.
        </ErrorText>
      )}
      {filesError && <ErrorText>The files weren’t moved: {filesError} Sync again to retry.</ErrorText>}
      {left && (
        <Muted as="p">
          {plural(left.books, 'book')} no longer chosen for here {left.books === 1 ? 'was' : 'were'} removed from this
          library (still on {hubName})
          {left.files > 0 && `, freeing ${formatSize(left.bytes)}`}.
        </Muted>
      )}
    </Section>
  );
}
