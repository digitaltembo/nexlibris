import { catalogAuth, readCredentials, writeCredentials } from '../catalogs/credentials';
import { loadFeed } from '../catalogs/feedCache';
import { textFetcher } from '../catalogs/remote';
import { sourceOf } from '../catalogs/sources';
import { CatalogBrowser } from './CatalogBrowser';
import { applyOperations, createDevice, deviceItemCount, readPairings, removePairing, type Device, type DevicePatch, type FirstSyncMode, type Item, type ItemId, type Library, type Operation, type NewPairing, type Pairing } from '@nexlibris/common';
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import styled from 'styled-components';
import {
  connectionContents,
  importFromConnection,
  linkOperations,
  removeOperations,
  type ContentEntry,
  type Contents,
} from '../devices/contents';
import { forgetFolder, mayWrite, savedFolder, saveFolder } from '../library/savedFolders';
import { exportCatalog, type CatalogSink, type ExportProgress, type ExportResult } from '../devices/opds/export';
import { canWriteFolders, directorySink, zipSink } from '../devices/opds/sinks';
import { listDevice, planSync, type DeviceListing, type SyncPlan } from '../devices/plan';
import { checkSend, needsAsking, type SendCheck } from '../devices/send';
import { addToDevice, catalogAdditions, deviceItems } from '../devices/selection';
import { runSync, type SyncProgress, type SyncResult } from '../devices/run';
import {
  isExport,
  isFeed,
  isFiles,
  isInstance,
  isServed,
  settingOf,
  type ConnectionType,
  type ExportType,
  type FilesType,
  type Inventory,
  type RemoteBook,
  type SettingField,
} from '../devices/types';
import { folderKey as connectionFolderKey, FOLDER_NAME } from '../connections/folder';
import { SendCheckStep } from './SendCheck';
import { BASIC_AUTH, SEARCH_ROUTING, servedFeedUrl } from '../connections/opds';
import { useServerSession } from '../library/account';
import { formatLabel } from './ItemFiles';
import { useLibrary } from '../library/LibraryContext';
import { CONNECTION_TYPES, connectionType } from '../connections';
import { canSync, transportOf } from '../sync/connect';
import { folderKey } from '../sync/folder';
import { instanceName } from '../sync/hub';
import { carryOverPairings, isInstanceConnection, pairedConnections } from '../sync/instances';
import { PairChoices, PairScreen, SyncInstance, transportLabel, useHostedPeers, type PairHow, type SyncDirection } from './InstanceSync';
import { InstanceContents } from './InstanceContents';
import { Button, Muted, SmallSelect, Spacer, Stack } from '../styles/ui';
import { DeleteButton } from './DeleteButton';
import { QueryInput } from './QueryInput';
import { recheckConnections, setConnectionActive, useConnectionStatus } from '../connections/active';
import { Modal, ModalFooter } from './Modal';
import { TagEditor } from './TagEditor';

const DeviceRow = styled.li`
  display: flex;
  gap: 8px;
  align-items: center;
  padding: 8px 0;
  border-bottom: 1px solid var(--border);

  div {
    display: flex;
    flex-direction: column;
    min-width: 0;
  }
`;

const Field = styled.label`
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-top: 12px;

  small {
    color: var(--muted);
  }
`;

const List = styled.ul`
  margin: 4px 0 0;
  padding-left: 20px;
  font-size: 0.9rem;
`;

const ErrorText = styled.p`
  margin: 12px 0 0;
  color: var(--danger);
`;

const KeepFound = styled.label`
  display: flex;
  gap: 6px;
  align-items: baseline;
  margin-top: 8px;
  color: var(--muted);
`;

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
const fileName = (path: string) => path.slice(path.lastIndexOf('/') + 1);
const errorMessage = (e: unknown) => (e instanceof Error ? e.message : String(e));

type Screen =
  | { kind: 'list' }
  | { kind: 'edit'; device?: Device }
  | { kind: 'sync'; device: Device }
  /** `importAll`: Sync from, bringing in everything there the library lacks once it's read. */
  | { kind: 'contents'; device: Device; importAll?: boolean }
  /** Choosing how to pair with another instance, then pairing that way: to add it, or to reach it from here. */
  | { kind: 'connect' }
  | { kind: 'pair'; how: PairHow }
  /** `start`: preview straight away (just after pairing), with this first-sync choice; `only`: just these books. */
  | {
      kind: 'instance';
      device: Device;
      pairing: Pairing;
      start?: { first: FirstSyncMode };
      direction?: SyncDirection;
      only?: { pull?: ItemId[]; push?: ItemId[] };
    }
  /** What another instance has for this one: through its pairing, or as it offered at its last sync here. */
  | { kind: 'instanceContents'; device: Device; pairing?: Pairing };

const when = (iso: string | undefined) => (iso ? new Date(iso).toLocaleString() : 'never');

/** Other instances first, this one leading them, then readers and catalogs as they were added. */
const order = (origin: string) => (device: Device) => (device.id === origin ? 0 : isInstanceConnection(device) ? 1 : 2);

/**
 * Connections: where the library goes. A reader that books are copied to, an OPDS catalog written
 * out for hosting, or another instance of nexlibris that the library syncs with. (The library
 * stores them as devices.) Adding and editing them, syncing each, and seeing what's on each; and,
 * in the apps, letting other instances connect to this one.
 */
export function ConnectionsDialog({ onClose, pair }: { onClose(): void; /** Opens on pairing this way, e.g. with the account. */ pair?: PairHow }) {
  const { library, backend, refresh } = useLibrary();
  const [screen, setScreen] = useState<Screen>(pair ? { kind: 'pair', how: pair } : { kind: 'list' });
  /** How this instance reaches others: kept here, not in the library. */
  const [pairings, setPairings] = useState<Pairing[]>([]);
  const loadPairings = useCallback(() => void readPairings(backend).then(setPairings), [backend]);
  useEffect(() => {
    void carryOverPairings(backend, instanceName())
      .then((changed) => changed && refresh())
      .finally(loadPairings);
  }, [backend, refresh, loadPairings]);
  const sortKey = order(library.origin);
  // Not this device's own connection: its catalog is what it gets from the others, and they keep it.
  const devices = Object.values(library.devices ?? {})
    .filter((device) => device.id !== library.origin)
    .sort((a, b) => sortKey(a) - sortKey(b));
  // Counted once per change to the library, not on every render: a search finds each catalog's books.
  const counts = useMemo(
    () => new Map(Object.values(library.devices ?? {}).map((device) => [device.id, deviceItemCount(library, device)])),
    [library],
  );
  const back = () => (loadPairings(), setScreen({ kind: 'list' }));
  const pairingOf = (device: Device) => pairings.find((p) => p.hub.origin === device.id);
  /** Devices paired with this one as their hub: shown on their connection's row, not again under hosting. */
  const hosted = useHostedPeers();
  const hostedPeer = (device: Device) => hosted.peers.find((p) => p.origin === device.id);
  const { status } = useConnectionStatus();
  /** Activate or Deactivate, for a connection activated by hand. */
  const toggle = (device: Device) => {
    const { active, manual } = status(device);
    if (!manual) return null;
    return (
      <Button
        $variant={active ? 'secondary' : 'primary'}
        $size="small"
        title={active ? `Takes ${device.name} out of the Library and Send to… on this device.` : `Puts ${device.name} in the Library and Send to… on this device, while it’s around.`}
        onClick={() => void setConnectionActive(backend, device.id, !active)}
      >
        {active ? 'Deactivate' : 'Activate'}
      </Button>
    );
  };
  /** "active", or "inactive" and why. */
  const statusText = (device: Device) => {
    const { active, reason } = status(device);
    return active ? 'active' : `inactive${reason && reason !== 'Not activated' ? `: ${reason}` : ''}`;
  };

  /** A deleted connection to another instance isn't reached from here any more either. */
  const forgetPairing = async (device: Device) => {
    const pairing = pairingOf(device);
    if (!pairing) return;
    await removePairing(backend, pairing.hub.origin);
    if (transportOf(pairing.address) === 'folder') await forgetFolder(folderKey(pairing.hub.origin)).catch(() => undefined);
  };

  const paired = async (pairing: NewPairing, first?: FirstSyncMode) => {
    // Both instances get connections now, so this one shows; they reach the other side on the sync. This one's
    // keeps the files the hub chose when it showed the code, so even the first sync fetches only those.
    const current = await backend.getLibrary();
    const ops = pairedConnections(current, pairing, instanceName());
    const updated = ops.length ? await backend.apply(ops) : current;
    await refresh();
    loadPairings();
    const device = updated.devices![pairing.hub.origin]!;
    setScreen({ kind: 'instance', device, pairing, start: { first: first ?? 'combine' } });
  };

  if (screen.kind === 'edit') {
    return (
      <EditConnection
        device={screen.device}
        onDone={back}
        onClose={onClose}
        onPair={(how) => setScreen({ kind: 'pair', how })}
        onRemoved={(device) => void forgetPairing(device).then(back)}
      />
    );
  }
  if (screen.kind === 'contents' && sourceOf(screen.device)) return <SourceContents device={screen.device} onDone={back} onClose={onClose} />;
  if (screen.kind === 'contents') return <ConnectionContents device={screen.device} importAll={!!screen.importAll} onDone={back} onClose={onClose} />;
  if (screen.kind === 'connect') {
    return (
      <Modal title="Connect another nexlibris" onClose={onClose}>
        <PairChoices onChoose={(how) => setScreen({ kind: 'pair', how })} />
        <ModalFooter>
          <Button $variant="secondary" onClick={back}>
            Back
          </Button>
        </ModalFooter>
      </Modal>
    );
  }
  if (screen.kind === 'pair') {
    return (
      <Modal title="Connect another nexlibris" onClose={onClose}>
        <PairScreen how={screen.how} onPaired={(pairing, first) => void paired(pairing, first)} onBack={back} />
      </Modal>
    );
  }
  if (screen.kind === 'instanceContents') {
    const { device, pairing } = screen;
    return (
      <InstanceContents
        device={device}
        {...(pairing && { pairing })}
        onDownload={(ids) => pairing && setScreen({ kind: 'instance', device, pairing, direction: 'from', only: { pull: ids } })}
        onDone={back}
        onClose={onClose}
      />
    );
  }
  if (screen.kind === 'instance') {
    return (
      <SyncInstance
        key={`${screen.direction ?? 'both'}:${screen.only?.pull?.join() ?? ''}:${screen.only?.push?.join() ?? ''}`}
        device={screen.device}
        pairing={screen.pairing}
        {...(screen.start && { start: screen.start })}
        {...(screen.direction && { direction: screen.direction })}
        {...(screen.only && { only: screen.only })}
        self={instanceName()}
        onBack={back}
        onClose={onClose}
      />
    );
  }
  if (screen.kind === 'sync') {
    const type = connectionType(screen.device.type)!;
    return isExport(type) ? (
      <SyncCatalog device={screen.device} type={type} onDone={back} onClose={onClose} />
    ) : isFiles(type) ? (
      <SyncDevice device={screen.device} type={type} onDone={back} onClose={onClose} />
    ) : null;
  }
  return (
    <Modal title="Connections" onClose={onClose}>
      {devices.length === 0 ? (
        <Muted as="p">
          Add a reader or a folder to send books to, an OPDS catalog to publish them, an OPDS server to browse, or nexlibris
          on another device to share books with. Each one you send to has a catalog of books: add to it with “Add to…” on
          books, or give it a search whose matches are added.
        </Muted>
      ) : (
        <Stack as="ul">
          {devices.map((device) => {
            const books = plural(counts.get(device.id) ?? 0, 'book');
            const { active } = status(device);
            if (isInstanceConnection(device)) {
              const pairing = pairingOf(device);
              const peer = hostedPeer(device);
              const link = pairing
                ? `${transportLabel(pairing)}, last synced ${when(pairing.lastSyncedAt)}`
                : peer
                  ? `syncs with this device, last synced ${when(peer.lastSyncedAt)}`
                  : 'not paired from here';
              return (
                <DeviceRow key={device.id}>
                  <div>
                    <strong>{device.name}</strong>
                    <Muted>
                      nexlibris · {link} · gets {books} · {statusText(device)}
                    </Muted>
                  </div>
                  <Spacer />
                  {toggle(device)}
                  <Button $variant="secondary" $size="small" onClick={() => setScreen({ kind: 'edit', device })}>
                    Edit
                  </Button>
                  <Button
                      $variant="secondary"
                      $size="small"
                      disabled={!active}
                      title={pairing ? `The books ${device.name} shows this device.` : `The books ${device.name} offered this device when it last synced.`}
                      onClick={() => setScreen({ kind: 'instanceContents', device, ...(pairing && { pairing }) })}
                    >
                      On it…
                    </Button>
                  {pairing ? (
                      <>
                        <Button
                          $variant="secondary"
                          $size="small"
                          disabled={!active}
                          title={`Brings every book ${device.name} shows this device that it doesn’t have.`}
                          onClick={() => setScreen({ kind: 'instance', device, pairing, direction: 'from' })}
                        >
                          Sync from
                        </Button>
                        <Button
                          $size="small"
                          disabled={!active}
                          title={`Sends every book in its catalog that ${device.name} doesn’t have. Nothing is deleted either side.`}
                          onClick={() => setScreen({ kind: 'instance', device, pairing, direction: 'to' })}
                        >
                          Sync to
                        </Button>
                      </>
                    ) : peer ? (
                      <Button
                        $variant="secondary"
                        $size="small"
                        title={`Unpairs ${device.name}: it can’t sync with this device until it pairs again. The connection stays.`}
                        onClick={() => void hosted.forget(peer.origin)}
                      >
                        Forget
                      </Button>
                    ) : (
                      canSync() && (
                        <Button $variant="secondary" $size="small" onClick={() => setScreen({ kind: 'connect' })}>
                          Pair…
                        </Button>
                      )
                    )}
                </DeviceRow>
              );
            }
            const source = sourceOf(device);
            if (source) {
              return (
                <DeviceRow key={device.id}>
                  <div>
                    <strong>{device.name}</strong>
                    <Muted>
                      {source.label} · {source.url(device) || 'no address'}
                    </Muted>
                  </div>
                  <Spacer />
                  <Button $variant="secondary" $size="small" onClick={() => setScreen({ kind: 'edit', device })}>
                    Edit
                  </Button>
                  <Button $size="small" disabled={!source.url(device)} onClick={() => setScreen({ kind: 'contents', device })}>
                    On it…
                  </Button>
                </DeviceRow>
              );
            }
            const type = connectionType(device.type);
            if (type && isServed(type)) {
              // Served by the server as it is: nothing to sync, only its address to give readers.
              const url = active ? servedFeedUrl(device) : undefined;
              return (
                <DeviceRow key={device.id}>
                  <div>
                    <strong>{device.name}</strong>
                    <Muted>
                      {type.label} · {books} in its catalog
                      {device.query && ` (adds “${device.query}”)`} · {url ? `at ${url}` : statusText(device)}
                    </Muted>
                  </div>
                  <Spacer />
                  <Button $variant="secondary" $size="small" onClick={() => setScreen({ kind: 'edit', device })}>
                    Edit
                  </Button>
                </DeviceRow>
              );
            }
            const folderName = type && isFiles(type) && type.pickFolder && device.settings[FOLDER_NAME];
            return (
              <DeviceRow key={device.id}>
                <div>
                  <strong>{device.name}</strong>
                  <Muted>
                    {type?.label ?? `Unknown type ${device.type}`}
                    {folderName && ` (“${String(folderName)}”)`} · {books} in its catalog
                    {device.query && ` (adds “${device.query}”)`}
                    {device.lastSyncedAt && ` · synced ${new Date(device.lastSyncedAt).toLocaleString()}`}
                    {` · ${statusText(device)}`}
                  </Muted>
                </div>
                <Spacer />
                {toggle(device)}
                <Button $variant="secondary" $size="small" onClick={() => setScreen({ kind: 'edit', device })}>
                  Edit
                </Button>
                <Button $variant="secondary" $size="small" disabled={!type || !active} onClick={() => setScreen({ kind: 'contents', device })}>
                  On it…
                </Button>
                {type?.read && (
                  <Button
                    $variant="secondary"
                    $size="small"
                    disabled={!active}
                    title="Brings in every book there that the library doesn’t have."
                    onClick={() => setScreen({ kind: 'contents', device, importAll: true })}
                  >
                    Sync from
                  </Button>
                )}
                <Button
                  $size="small"
                  disabled={!type?.write || !active}
                  title="Sends every book in its catalog that isn’t there yet, and newer copies of ones that changed. Nothing there is deleted."
                  onClick={() => setScreen({ kind: 'sync', device })}
                >
                  Sync to
                </Button>
              </DeviceRow>
            );
          })}
        </Stack>
      )}
      <ModalFooter>
        <Button $variant="secondary" onClick={() => setScreen({ kind: 'edit' })}>
          Add connection
        </Button>
        <Spacer />
        <Button $variant="secondary" onClick={onClose}>
          Close
        </Button>
      </ModalFooter>
    </Modal>
  );
}

/** The types offered when adding a connection, as one list: readers and folders, the export, other instances, servers, feeds served. */
const TYPE_CHOICES = [
  ...CONNECTION_TYPES.filter(isFiles),
  ...CONNECTION_TYPES.filter(isExport),
  ...CONNECTION_TYPES.filter(isInstance),
  ...CONNECTION_TYPES.filter(isFeed),
  ...CONNECTION_TYPES.filter(isServed),
];

/** What a kind of connection's search is called. */
const SEARCH_LABEL = { device: 'Add books by search', catalog: 'Add books by search', instance: 'Books it sees' };

function EditConnection({
  device,
  onDone,
  onClose,
  onPair,
  onRemoved,
}: {
  device?: Device;
  onDone(): void;
  onClose(): void;
  /** For a new connection to another instance: pairing with it, this way. */
  onPair(how: PairHow): void;
  /** After the connection is deleted, e.g. to forget how this instance reached it. */
  onRemoved(device: Device): void;
}) {
  const { library, backend, apply } = useLibrary();
  const [typeId, setTypeId] = useState(device?.type ?? CONNECTION_TYPES[0]!.id);
  const [query, setQuery] = useState(device?.query ?? '');
  const type = connectionType(typeId);
  const instance = !!type && isInstance(type);
  // A catalog that's browsed takes no books, so has no catalog or search.
  const source = !!type && isFeed(type);
  const kind = !type ? 'device' : isExport(type) || isServed(type) ? 'catalog' : instance ? 'instance' : 'device';
  // A feed the server serves is offered only while signed in to one.
  const signedIn = !!useServerSession()?.account;
  const choices = TYPE_CHOICES.filter((t) => !isServed(t) || signedIn || t.id === device?.type);
  const pickFolder = !!type && isFiles(type) && !!type.pickFolder;
  /** A folder connection's folder, picked here: kept on this computer only. */
  const [folder, setFolder] = useState<FileSystemDirectoryHandle>();
  useEffect(() => {
    if (!device || !pickFolder) return;
    let cancelled = false;
    void savedFolder(connectionFolderKey(device.id)).then((saved) => !cancelled && saved && setFolder(saved));
    return () => {
      cancelled = true;
    };
  }, [device, pickFolder]);
  const chooseFolder = async () => {
    try {
      setFolder(await window.showDirectoryPicker!({ id: `connection-${device?.id ?? 'new'}`.slice(0, 32), mode: 'readwrite' }));
    } catch {
      // Cancelled.
    }
  };
  const self = device?.id === library.origin;
  const [name, setName] = useState(device?.name ?? '');
  const [settings, setSettings] = useState<Record<string, string>>(() =>
    Object.fromEntries(Object.entries(device?.settings ?? {}).map(([k, v]) => [k, String(v ?? '')])),
  );

  /** A browsed catalog's sign-in, read from this device's local state. */
  const [signIn, setSignIn] = useState({ username: '', password: '' });
  useEffect(() => {
    if (!device || !source) return;
    let cancelled = false;
    void readCredentials(backend, device.id).then((c) => !cancelled && c && setSignIn(c));
    return () => {
      cancelled = true;
    };
  }, [backend, device, source]);
  const insecure = source && !!signIn.username && /^http:/i.test(settings.url ?? '');

  const save = async () => {
    const values: Record<string, string | undefined> = Object.fromEntries((type?.settings ?? []).map((f) => [f.key, settings[f.key]?.trim() || undefined]));
    if (pickFolder) values[FOLDER_NAME] = folder?.name ?? (device?.settings[FOLDER_NAME] as string | undefined);
    const label = name.trim() || type?.label || 'Connection';
    let id = device?.id;
    if (device) {
      const patch: DevicePatch = { name: label, settings: values, query };
      await apply([{ type: 'updateDevice', id: device.id, patch }]);
    } else {
      const defined = Object.fromEntries(Object.entries(values).filter(([, v]) => v !== undefined)) as Record<string, string>;
      const added = createDevice({ name: label, type: typeId, settings: defined, query });
      id = added.id;
      await apply([{ type: 'addDevice', device: added }]);
    }
    if (pickFolder && folder && id) {
      await saveFolder(connectionFolderKey(id), folder);
      const saved = (await backend.getLibrary()).devices?.[id];
      if (saved) await recheckConnections([saved]);
    }
    if (type && isFeed(type) && id) {
      // The sign-in stays on this device: in its local state, not the library.
      await writeCredentials(backend, id, signIn.username.trim() || signIn.password ? { username: signIn.username.trim(), password: signIn.password } : undefined);
      // A catalog's start, read now so its search is offered straight away (and kept for a day, as browsing it would).
      if (typeof values.url === 'string') {
        const url = values.url;
        void catalogAuth(backend, id, url)
          .then((auth) => loadFeed(backend, url, textFetcher(auth)))
          .catch(() => undefined);
      }
    }
    onDone();
  };

  return (
    <Modal title={device ? `Edit ${device.name}` : 'Add connection'} onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <Field>
          Type
          <SmallSelect value={typeId} disabled={!!device} onChange={(e) => setTypeId(e.target.value)}>
            {choices.map((t) => (
              <option key={t.id} value={t.id}>
                {t.label}
              </option>
            ))}
          </SmallSelect>
        </Field>
        {instance && !device ? (
          <>
            <PairChoices onChoose={onPair} />
            <ModalFooter>
              <Spacer />
              <Button $variant="secondary" onClick={onDone}>
                Cancel
              </Button>
            </ModalFooter>
          </>
        ) : (
          <>
        <Field>
          Name
          <input value={name} placeholder={type?.label} onChange={(e) => setName(e.target.value)} />
        </Field>
        {source && (
          <Muted as="p">
            Browse its books in the Library and under “On it…”, and add them to the library from there. Nothing is sent to it.
          </Muted>
        )}
        {!source && (
        <Field>
          {SEARCH_LABEL[kind]}
          <QueryInput value={query} onChange={setQuery} />
          <small>
            {instance
              ? `${self ? 'This device' : device!.name} sees the books matching this search, and books you add to it: their details, covers and files. It doesn’t see the others, and nothing either side deletes is deleted on the other.`
              : `Books matching it, as in the search box (say, tag:xteink, or rating:4+ author:herbert), are added to its catalog beside the books you add to it, and stay there; take one out by hand to keep it out.`}
          </small>
        </Field>
        )}
        {pickFolder && (
          <Field as="div">
            Folder
            <div>
              <Button $variant="secondary" $size="small" onClick={() => void chooseFolder()}>
                {folder ? `“${folder.name}”: choose another…` : 'Choose folder…'}
              </Button>
            </div>
            <small>
              Where its books are, on this computer (a backup drive, a reader that mounts as one). Each computer chooses it
              for itself; a manifest there, .nexlibris-library.json, keeps the books’ details.
            </small>
          </Field>
        )}
        {source && (
          <Field as="div">
            Sign-in (optional)
            <SignInRow>
              <input
                aria-label="User name"
                placeholder="User name"
                autoComplete="off"
                value={signIn.username}
                onChange={(e) => setSignIn({ ...signIn, username: e.target.value })}
              />
              <input
                aria-label="Password"
                placeholder="Password"
                type="password"
                autoComplete="new-password"
                value={signIn.password}
                onChange={(e) => setSignIn({ ...signIn, password: e.target.value })}
              />
            </SignInRow>
            <small>
              For a catalog that asks for one (HTTP Basic). Kept on this device only, sent only to the catalog’s own server.
            </small>
            {insecure && <small role="alert">This address isn’t https, so the password would be sent unencrypted.</small>}
          </Field>
        )}
        {type?.settings.map((field) => (
          // A `some` field holds a checkbox and an input of its own, so it isn't one label.
          <Field key={field.key} {...(field.kind === 'some' && { as: 'div' as const })}>
            {field.label}
            {field.kind === 'checkbox' ? (
              <CheckRow>
                <input
                  type="checkbox"
                  checked={(settings[field.key] || field.default) === 'yes'}
                  onChange={(e) => setSettings({ ...settings, [field.key]: e.target.checked ? 'yes' : 'no' })}
                />
              </CheckRow>
            ) : field.kind === 'some' ? (
              <SomeChoices field={field} value={settings[field.key] ?? ''} onChange={(value) => setSettings({ ...settings, [field.key]: value })} />
            ) : field.choices ? (
              <SmallSelect
                value={settings[field.key] || field.default}
                onChange={(e) => setSettings({ ...settings, [field.key]: e.target.value })}
              >
                {field.choices.map((choice) => (
                  <option key={choice.value} value={choice.value}>
                    {choice.label}
                  </option>
                ))}
              </SmallSelect>
            ) : (
              <input
                value={settings[field.key] ?? ''}
                placeholder={field.default}
                {...(field.range && { type: 'number', min: field.range.min, max: field.range.max, step: 1 })}
                onChange={(e) => setSettings({ ...settings, [field.key]: e.target.value })}
              />
            )}
            {field.help && <small>{field.help}</small>}
            <SettingCheck field={field} settings={settings} />
          </Field>
        ))}
        <ModalFooter>
          {device && !self && (
            <DeleteButton
              what={device.name}
              onDelete={() =>
                void apply([{ type: 'removeDevice', id: device.id }])
                  .then(() => (source ? writeCredentials(backend, device.id, undefined) : undefined))
                  .then(() => onRemoved(device))
              }
            />
          )}
          <Spacer />
          <Button $variant="secondary" onClick={onDone}>
            Cancel
          </Button>
          <Button
            type="submit"
            disabled={
              (pickFolder && !folder && !device) ||
              (source && !!type?.settings.some((f) => f.check?.(settings[f.key] ?? f.default, settings, library).problems?.length))
            }
          >
            {device ? 'Save' : 'Add'}
          </Button>
        </ModalFooter>
          </>
        )}
      </form>
    </Modal>
  );
}

type SyncState =
  | { kind: 'connecting' }
  /** Asking first whether to convert or update the books to send (`SendCheckStep`). */
  | { kind: 'asking'; check: SendCheck }
  | { kind: 'planned'; description: string; plan: SyncPlan; library: Library; listing: DeviceListing; keepFound: boolean; adding: Operation[] }
  | { kind: 'syncing'; progress: SyncProgress }
  | { kind: 'done'; result: SyncResult }
  | { kind: 'failed'; message: string };

/**
 * Sync to a reader or folder: connecting, a preview of what it will add, then carrying it out. What the
 * connection's search matches now is added to its catalog first. Given `only`, it sends just those books
 * (adding any not in its catalog yet, as it sends them), leaving everything else on it as it is. Books
 * without a format it prefers, or whose files' details are behind, are asked about first (`SendCheckStep`).
 */
export function SyncDevice({
  device,
  type,
  only,
  onDone,
  onClose,
}: {
  device: Device;
  type: FilesType;
  only?: ItemId[];
  onDone(): void;
  onClose(): void;
}) {
  const { library, backend, apply } = useLibrary();
  const [state, setState] = useState<SyncState>({ kind: 'connecting' });
  const title = (id: string) => library.items[id]?.title ?? 'A removed item';
  const options = (keepFound: boolean) => ({ keepFound, ...(only && { only }) });

  /** Whether the books to send have been asked about (once). */
  const [asked, setAsked] = useState(false);
  const check = async (ask = !asked) => {
    setState({ kind: 'connecting' });
    try {
      const target = type.target(device);
      const { description } = await target.connect();
      const stored = await backend.getLibrary();
      const latest = stored.devices?.[device.id] ?? device;
      const chosen = new Set(deviceItems(stored, latest).map((i) => i.id));
      const missing = (only ?? []).filter((id) => !chosen.has(id) && stored.items[id]);
      const adding = [...(only ? [] : catalogAdditions(stored, latest)), ...(missing.length ? addToDevice(latest, missing) : [])];
      // Planned as if they were chosen already; they are once sent.
      const library = adding.length ? applyOperations(stored, adding).library : stored;
      const current = library.devices?.[device.id] ?? device;
      const listed = await listDevice(current, type, target, library);
      // The whole device, to find copies of chosen books outside the folders a sync lists.
      const found = type.inventory ? (await type.inventory(current, target, library, listed.files)).books : undefined;
      const listing = { ...listed, ...(found && { found }) };
      const plan = planSync(library, current, type, listing, options(true));
      if (ask) {
        const sending = [...new Map(plan.uploads.map((u) => [u.item.id, u.item])).values()];
        const unsendable = plan.unsendable.map((id) => library.items[id]!).filter(Boolean);
        const asking = checkSend(library, current, type, [...sending, ...unsendable]);
        if (needsAsking(asking)) {
          setState({ kind: 'asking', check: asking });
          return;
        }
      }
      setState({ kind: 'planned', description, plan, library, listing, keepFound: true, adding });
    } catch (e) {
      setState({ kind: 'failed', message: errorMessage(e) });
    }
  };
  // Once, on opening. Only reads from the device, so it's harmless when StrictMode runs it twice.
  // oxlint-disable-next-line react-hooks/exhaustive-deps, react/set-state-in-effect
  useEffect(() => void check(), []);

  const sync = async (plan: SyncPlan, adding: Operation[]) => {
    setState({ kind: 'syncing', progress: { done: 0, total: plan.moves.length + plan.uploads.length + plan.removals.length } });
    try {
      if (adding.length) await apply(adding);
      const library = await backend.getLibrary();
      const target = type.target(device);
      const result = await runSync(library, library.devices?.[device.id] ?? device, plan, target, backend, (progress) =>
        setState({ kind: 'syncing', progress }),
      );
      await apply(result.operations);
      if (type.afterSync) {
        const latest = await backend.getLibrary();
        await type.afterSync(latest.devices?.[device.id] ?? device, target, latest, backend);
      }
      setState({ kind: 'done', result });
    } catch (e) {
      setState({ kind: 'failed', message: errorMessage(e) });
    }
  };

  const busy = state.kind === 'connecting' || state.kind === 'syncing' || state.kind === 'asking';
  const work =
    state.kind === 'planned'
      ? state.plan.uploads.length + state.plan.moves.length + state.plan.kept.length + state.plan.removals.length + (state.plan.catalog ? 1 : 0)
      : 0;
  return (
    <Modal title={only ? `Send to ${device.name}` : `Sync ${device.name}`} onClose={busy ? () => undefined : onClose}>
      {state.kind === 'connecting' && <Muted as="p">Connecting to {device.name}…</Muted>}
      {state.kind === 'asking' && (
        <SendCheckStep
          device={device}
          type={type}
          check={state.check}
          onContinue={() => {
            setAsked(true);
            void check(false);
          }}
          onCancel={onDone}
        />
      )}
      {state.kind === 'planned' && (
        <PlanSummary
          description={state.description}
          plan={state.plan}
          title={title}
          keepFound={state.keepFound}
          onKeepFound={(keepFound) => {
            const current = state.library.devices?.[device.id] ?? device;
            setState({ ...state, keepFound, plan: planSync(state.library, current, type, state.listing, options(keepFound)) });
          }}
        />
      )}
      {state.kind === 'syncing' && (
        <p role="status">
          {state.progress.current ?? 'Syncing'} ({Math.min(state.progress.done + 1, state.progress.total)} of{' '}
          {state.progress.total})…
        </p>
      )}
      {state.kind === 'done' && (
        <>
          <p role="status">
            {state.result.sent || state.result.removed || state.result.moved || state.result.kept
              ? `Sent ${plural(state.result.sent, 'file')}${state.result.moved ? `, moved ${state.result.moved}` : ''}${state.result.kept ? `, kept ${state.result.kept} already there` : ''}${state.result.removed ? `, replaced ${state.result.removed} old ${state.result.removed === 1 ? 'copy' : 'copies'}` : ''}.`
              : !state.result.catalogAdded && !state.result.takenOut && 'Nothing needed doing.'}
            {state.result.takenOut > 0 && ` Took ${plural(state.result.takenOut, 'book')} deleted there out of its catalog.`}
            {state.result.catalogAdded && ' Added the catalog to the reader’s OPDS libraries.'}
          </p>
          {state.result.errors.length > 0 && (
            <>
              <ErrorText role="alert">Some steps failed:</ErrorText>
              <List>
                {state.result.errors.map((e) => (
                  <li key={e.path}>
                    {e.path}: {e.message}
                  </li>
                ))}
              </List>
            </>
          )}
        </>
      )}
      {state.kind === 'failed' && <ErrorText role="alert">{state.message}</ErrorText>}

      {state.kind !== 'asking' && (
      <ModalFooter>
        <Button $variant="secondary" disabled={busy} onClick={onDone}>
          Back
        </Button>
        <Spacer />
        {state.kind === 'failed' && <Button onClick={() => void check()}>Try again</Button>}
        {state.kind === 'planned' && (
          <Button disabled={work === 0 && !state.adding.length && !state.plan.deleted.length} onClick={() => void sync(state.plan, state.adding)}>
            {work === 0 ? (state.adding.length || state.plan.deleted.length ? 'Update catalog' : 'Up to date') : only ? 'Send' : 'Sync to'}
          </Button>
        )}
        {state.kind === 'done' && (
          <Button $variant="secondary" onClick={onClose}>
            Close
          </Button>
        )}
      </ModalFooter>
      )}
    </Modal>
  );
}

/** A setting's check, as it's typed: problems, and an example of what it does. */
function SettingCheck({ field, settings }: { field: SettingField; settings: Record<string, string> }) {
  const { library } = useLibrary();
  if (!field.check) return null;
  const { problems, example } = field.check(settings[field.key]?.trim() || field.default, settings, library);
  return (
    <>
      {problems?.map((p) => (
        <ErrorText key={p} as="small">
          {p}
        </ErrorText>
      ))}
      {example && <small>For example: {example}</small>}
    </>
  );
}

export function PlanSummary({
  description,
  plan,
  title,
  keepFound,
  onKeepFound,
}: {
  description: string;
  plan: SyncPlan;
  title(id: string): string;
  keepFound?: boolean;
  onKeepFound?(keep: boolean): void;
}) {
  const foundMoves = plan.moves.filter((m) => m.found);
  const found = foundMoves.length + plan.kept.length;
  const replacing = plan.uploads.filter((u) => u.replaces).length;
  const sending = plan.uploads.length - replacing;
  const changes = [
    sending > 0 && `send ${plural(sending, 'file')}`,
    plan.kept.length > 0 && `keep ${plan.kept.length === 1 ? '1 copy' : `${plan.kept.length} copies`} already there`,
    plan.moves.length > 0 && `move ${plan.moves.length} to ${plan.moves.length === 1 ? 'its new place' : 'their new places'}`,
    replacing > 0 && `update ${replacing}`,
  ].filter(Boolean);
  return (
    <>
      <Muted as="p">Connected: {description}.</Muted>
      <p>
        {changes.length ? `Will ${changes.join(', ')}.` : 'Everything in its catalog is already there.'}
        {plan.catalog && ` Will add the catalog at ${plan.catalog.url} to the reader’s OPDS libraries.`}
        {plan.unchanged > 0 && changes.length > 0 && ` ${plan.unchanged} already there.`}
      </p>
      {plan.uploads.length + plan.moves.length > 0 && (
        <List>
          {plan.moves.map((m) => (
            <li key={m.to}>
              {m.to} <Muted>({m.found ? 'already on the device, ' : ''}moved from {m.from})</Muted>
            </li>
          ))}
          {plan.uploads.map((u) => (
            <li key={u.path}>
              {fileName(u.path)}{' '}
              <Muted>
                ({formatLabel(u.file.format)}
                {u.supersedes ? `, replacing ${fileName(u.supersedes)}` : u.replaces && ', updated'})
              </Muted>
            </li>
          ))}
          {plan.kept.map((k) => (
            <li key={k.path}>
              {fileName(k.path)} <Muted>(already there, kept)</Muted>
            </li>
          ))}
        </List>
      )}
      {plan.deleted.length > 0 && (
        <Muted as="p">
          Deleted there since the last sync, so taken out of its catalog rather than sent again: {plan.deleted.map(title).join(', ')}.
        </Muted>
      )}
      {plan.left > 0 && <Muted as="p">{plural(plan.left, 'file')} no longer in its catalog left there as they are.</Muted>}
      {onKeepFound && (found > 0 || keepFound === false) && (
        <KeepFound>
          <input type="checkbox" checked={keepFound !== false} onChange={(e) => onKeepFound(e.target.checked)} />
          Keep copies of these books already on the device (put there by hand or by other software) rather than sending
          nexlibris’s. They’re sent again once the book’s file in the library changes.
        </KeepFound>
      )}
      {plan.conflicts.length > 0 && (
        <>
          <p>Left alone:</p>
          <List>
            {plan.conflicts.map((c) => (
              <li key={c.path}>
                {c.path}: {c.reason}
              </li>
            ))}
          </List>
        </>
      )}
      {plan.unsendable.length > 0 && (
        <Muted as="p">Not sent, with no file the device reads: {plan.unsendable.map(title).join(', ')}.</Muted>
      )}
    </>
  );
}

type CatalogState =
  | { kind: 'loading' }
  | { kind: 'ready'; folder?: FileSystemDirectoryHandle }
  | { kind: 'exporting'; progress: ExportProgress; folder?: FileSystemDirectoryHandle }
  | { kind: 'done'; result: ExportResult; saved: boolean; folder?: FileSystemDirectoryHandle }
  | { kind: 'failed'; message: string; folder?: FileSystemDirectoryHandle };

/**
 * Sync to a static catalog: writing it again, to the folder it was last written to on this computer
 * (only what changed is copied; book files no longer in it stay, unlisted), or to a zip where the
 * browser can't write folders (the Android app, Firefox, Safari). What its search matches now is
 * added to its catalog first.
 */
function SyncCatalog({ device, type, onDone, onClose }: { device: Device; type: ExportType; onDone(): void; onClose(): void }) {
  const { library: current, backend, apply } = useLibrary();
  const count = deviceItemCount(current, current.devices?.[device.id] ?? device);
  const [state, setState] = useState<CatalogState>({ kind: 'loading' });
  const folder = state.kind === 'loading' ? undefined : state.folder;
  const catalogKey = `catalog:${device.id}`;

  useEffect(() => {
    let cancelled = false;
    void savedFolder(catalogKey).then((saved) => !cancelled && setState({ kind: 'ready', ...(saved && { folder: saved }) }));
    return () => {
      cancelled = true;
    };
  }, [catalogKey]);

  const run = async (sink: CatalogSink & { saved?: boolean }, to?: FileSystemDirectoryHandle) => {
    setState({ kind: 'exporting', progress: { done: 0, total: count }, ...(to && { folder: to }) });
    try {
      const before = await backend.getLibrary();
      const additions = catalogAdditions(before, before.devices?.[device.id] ?? device);
      if (additions.length) await apply(additions);
      const library = additions.length ? await backend.getLibrary() : before;
      const latest = library.devices?.[device.id] ?? device;
      const cloudflare = { searchRouting: settingOf(latest, SEARCH_ROUTING) === 'yes', basicAuth: settingOf(latest, BASIC_AUTH) === 'yes' };
      const result = await exportCatalog(
        library,
        latest,
        type,
        backend,
        sink,
        (progress) => setState({ kind: 'exporting', progress, ...(to && { folder: to }) }),
        cloudflare,
      );
      const saved = sink.saved ?? true;
      // What the catalog now holds, for "On it…" and the last sync time.
      const gone = Object.keys(latest.placed).filter((path) => !result.placed[path]);
      if (saved) await apply([{ type: 'recordDeviceSync', id: device.id, placed: result.placed, removed: gone }]);
      setState({ kind: 'done', result, saved, ...(to && { folder: to }) });
    } catch (e) {
      setState({ kind: 'failed', message: errorMessage(e), ...(to && { folder: to }) });
    }
  };
  const toFolder = async (chosen?: FileSystemDirectoryHandle) => {
    let target = chosen;
    if (!target) {
      try {
        target = await window.showDirectoryPicker!({ id: `catalog-${device.id}`, mode: 'readwrite' });
      } catch {
        return; // Cancelled.
      }
      await saveFolder(catalogKey, target);
    } else if (!(await mayWrite(target))) {
      setState({ kind: 'failed', message: `nexlibris wasn’t allowed to write to ${target.name}.`, folder: target });
      return;
    }
    await run(directorySink(target), target);
  };
  const toZip = () => run(zipSink(`${device.name}.zip`));
  const forget = async () => {
    await forgetFolder(catalogKey);
    setState({ kind: 'ready' });
  };

  const busy = state.kind === 'exporting' || state.kind === 'loading';
  const url = typeof device.settings.url === 'string' && device.settings.url.trim();
  return (
    <Modal title={`Sync ${device.name}`} onClose={busy ? () => undefined : onClose}>
      {(state.kind === 'ready' || state.kind === 'failed') && (
        <Muted as="p">
          A static OPDS catalog of {plural(count, 'book')}, for hosting anywhere that serves files (it’s meant for the root of a
          site){url && <>, at {url}</>}. Books go as their files are; book files written before stay, even once out of the
          catalog.{' '}
          {folder
            ? `It’s written to the folder “${folder.name}” on this computer; only what changed is copied.`
            : canWriteFolders()
              ? 'Choose a folder to write it to (the one your site is deployed from, say): later syncs update it in place.'
              : 'This browser can’t write to folders, so each sync saves the whole catalog as a zip.'}
        </Muted>
      )}
      {state.kind === 'exporting' && (
        <p role="status">
          {state.progress.current ?? 'Writing'} ({Math.min(state.progress.done + 1, state.progress.total)} of{' '}
          {state.progress.total})…
        </p>
      )}
      {state.kind === 'done' && (
        <>
          <p role="status">
            {state.saved ? `Wrote the catalog of ${plural(state.result.books, 'book')}` : 'Not saved'}
            {state.saved && state.result.unchanged > 0 && `; ${state.result.unchanged} file(s) were already up to date`}
            {state.saved && state.result.removed > 0 && `; removed ${plural(state.result.removed, 'page')} no longer needed`}
            {state.saved && state.folder && ` in “${state.folder.name}”`}.
          </p>
          {state.result.skipped.length > 0 && (
            <List>
              {state.result.skipped.map((title) => (
                <li key={`s:${title}`}>{title}: left out, with no file in a format the catalog takes</li>
              ))}
            </List>
          )}
        </>
      )}
      {state.kind === 'failed' && <ErrorText role="alert">{state.message}</ErrorText>}
      <ModalFooter>
        <Button $variant="secondary" disabled={busy} onClick={onDone}>
          Back
        </Button>
        {folder && (state.kind === 'ready' || state.kind === 'failed') && (
          <Button $variant="secondary" onClick={() => void forget()}>
            Forget folder
          </Button>
        )}
        <Spacer />
        {(state.kind === 'ready' || state.kind === 'failed') && (
          <>
            {canWriteFolders() && (
              <Button $variant="secondary" onClick={() => void toFolder()}>
                {folder ? 'Another folder…' : 'Choose folder…'}
              </Button>
            )}
            <Button $variant={folder ? 'secondary' : 'primary'} onClick={() => void toZip()}>
              Save as zip
            </Button>
            {folder && <Button onClick={() => void toFolder(folder)}>Sync</Button>}
          </>
        )}
        {state.kind === 'done' && (
          <Button $variant="secondary" onClick={onClose}>
            Close
          </Button>
        )}
      </ModalFooter>
    </Modal>
  );
}

type ContentsState =
  | { kind: 'loading' }
  | { kind: 'ready'; inventory: Inventory; description?: string }
  | { kind: 'failed'; message: string };

/** A browsed catalog's pages (`CatalogBrowser`), with a trail back through the ones opened. */
function SourceContents({ device, onDone, onClose }: { device: Device; onDone(): void; onClose(): void }) {
  const root = sourceOf(device)!.url(device);
  const [trail, setTrail] = useState<{ url: string; title: string }[]>([]);
  const step = trail.at(-1);
  return (
    <Modal title={`On ${device.name}`} onClose={onClose}>
      {trail.length > 0 && (
        <Trail>
          <LinkLike onClick={() => setTrail([])}>{device.name}</LinkLike>
          {trail.map((t, i) => (
            <span key={`${i}:${t.url}`}>
              {' › '}
              {i === trail.length - 1 ? t.title : <LinkLike onClick={() => setTrail(trail.slice(0, i + 1))}>{t.title}</LinkLike>}
            </span>
          ))}
        </Trail>
      )}
      <CatalogBrowser
        key={step?.url ?? root}
        device={device}
        root={root}
        {...(step && { step: step.url })}
        onOpen={(url, title) => setTrail([...trail, { url, title }])}
        embedded
      />
      <ModalFooter>
        <Spacer />
        <Button $variant="secondary" onClick={onDone}>
          Back
        </Button>
      </ModalFooter>
    </Modal>
  );
}

const CheckRow = styled.span`
  display: flex;
`;

const OnlyRow = styled.label`
  display: flex;
  gap: 6px;
  align-items: baseline;
`;

/**
 * A `some` setting: all of its choices unless "Only specific …" is checked, then the ones picked, as
 * chips (`TagEditor`). Stored as the picked values joined by commas, empty for all of them.
 */
function SomeChoices({ field, value, onChange }: { field: SettingField; value: string; onChange(value: string): void }) {
  const all = useMemo(() => (field.choices ?? []).map((c) => c.value), [field.choices]);
  const stored = (value.trim() ? value : field.default).split(',').map((v) => v.trim()).filter((v) => all.includes(v));
  // Checked while it's picking, even with every chip removed (which, saved, means all again).
  const [only, setOnly] = useState(stored.length > 0);
  const set = (values: string[]) => onChange(all.filter((v) => values.includes(v)).join(','));
  const noun = field.label.toLowerCase().replace(/s$/, '');
  return (
    <>
      <OnlyRow>
        <input
          type="checkbox"
          checked={only}
          onChange={(e) => {
            setOnly(e.target.checked);
            if (!e.target.checked) onChange('');
          }}
        />
        Only specific {field.label.toLowerCase()}
      </OnlyRow>
      {only && (
        <TagEditor
          tags={stored}
          candidates={all}
          only
          noun={noun}
          onAdd={(added) => set([...stored, ...added])}
          onRemove={(removed) => set(stored.filter((v) => v !== removed))}
        />
      )}
    </>
  );
}

const SignInRow = styled.div`
  display: flex;
  gap: 8px;

  input {
    flex: 1;
    min-width: 0;
  }
`;

const Trail = styled.p`
  margin: 0 0 8px;
  color: var(--muted);
`;

const LinkLike = styled.button.attrs({ type: 'button' })`
  padding: 0;
  border: none;
  background: none;
  color: inherit;
  font: inherit;
  text-decoration: underline;
  cursor: pointer;
`;

/**
 * What's on a connection: read from it (or, for a static catalog, what its last export wrote), then shown with
 * `ContentsView`. With `importAll` (Sync from), every book there the library lacks is brought in once it's read.
 */
function ConnectionContents({ device, importAll, onDone, onClose }: { device: Device; importAll: boolean; onDone(): void; onClose(): void }) {
  const { library, backend, refresh } = useLibrary();
  const type = connectionType(device.type)!;
  const current = library.devices?.[device.id] ?? device;
  const [state, setState] = useState<ContentsState>({ kind: 'loading' });
  /** `books`, or one of the device type's tools. */
  const [tab, setTab] = useState('books');
  const [working, setWorking] = useState<string>();
  const [error, setError] = useState<string>();

  const load = async () => {
    setState({ kind: 'loading' });
    try {
      if (!isFiles(type)) {
        const books = Object.entries(current.placed).map(([path, placed]) => ({ path, size: placed.size }));
        setState({ kind: 'ready', inventory: { books } });
        return;
      }
      const target = type.target(device);
      const { description } = await target.connect();
      const library = await backend.getLibrary();
      const latest = library.devices?.[device.id] ?? device;
      const inventory = type.inventory
        ? await type.inventory(latest, target, library)
        : { books: (await listDevice(latest, type, target, library)).files };
      setState({ kind: 'ready', inventory, description });
      if (importAll) {
        const unknown = connectionContents(library, latest, type, inventory.books).entries.filter((e) => e.kind === 'unknown');
        await bringIn(unknown.map((e) => e.book));
      }
    } catch (e) {
      setState({ kind: 'failed', message: errorMessage(e) });
    }
  };
  // Once, on opening. Only reads, so it's harmless when StrictMode runs it twice.
  // oxlint-disable-next-line react-hooks/exhaustive-deps, react/set-state-in-effect
  useEffect(() => void load(), []);

  const act = async (books: RemoteBook[], work: (book: RemoteBook) => Promise<void>) => {
    setError(undefined);
    for (const book of books) {
      setWorking(book.path);
      try {
        await work(book);
      } catch (e) {
        setError(`${fileName(book.path)}: ${errorMessage(e)}`);
        break;
      }
    }
    setWorking(undefined);
    await refresh();
  };
  const link = (entries: Extract<ContentEntry, { kind: 'match' }>[]) =>
    act(
      entries.map((e) => e.book),
      async (book) => {
        const latest = await backend.getLibrary();
        const entry = entries.find((e) => e.book === book)!;
        await backend.apply(linkOperations(latest, latest.devices?.[device.id] ?? device, type, book, entry.item));
      },
    );
  /** Deletes the book's file on the device, then takes the book off the connection (`removeOperations`). */
  const remove = (entry: ContentEntry) =>
    act([entry.book], async (book) => {
      if (!isFiles(type)) return;
      await type.target(device).remove(book.path);
      const latest = await backend.getLibrary();
      const ops = removeOperations(latest, latest.devices?.[device.id] ?? device, entry);
      if (ops.length) await backend.apply(ops);
      setState((s) => (s.kind === 'ready' ? { ...s, inventory: { ...s.inventory, books: s.inventory.books.filter((b) => b.path !== book.path) } } : s));
    });
  const bringIn = (books: RemoteBook[]) =>
    act(books, async (book) => {
      if (!isFiles(type)) return;
      const latest = (await backend.getLibrary()).devices?.[device.id] ?? device;
      await importFromConnection(backend, latest, type, type.target(device), book);
    });

  const tools = isFiles(type) ? (type.tools ?? []) : [];
  const Tool = tools.find((t) => t.id === tab)?.component;

  return (
    <Modal title={`On ${device.name}`} onClose={working ? () => undefined : onClose}>
      {tools.length > 0 && (
        <Tabs role="tablist">
          {[{ id: 'books', label: 'Books' }, ...tools].map((t) => (
            <button key={t.id} type="button" role="tab" aria-selected={tab === t.id} disabled={!!working} onClick={() => setTab(t.id)}>
              {t.label}
            </button>
          ))}
        </Tabs>
      )}
      {Tool && <Tool device={current} />}
      {!Tool && state.kind === 'loading' && <Muted as="p">{isExport(type) ? 'Reading…' : `Connecting to ${device.name}…`}</Muted>}
      {!Tool && state.kind === 'failed' && <ErrorText role="alert">{state.message}</ErrorText>}
      {!Tool && state.kind === 'ready' && (
        <ContentsView
          type={type}
          contents={connectionContents(library, current, type, state.inventory.books)}
          {...(state.description && { description: state.description })}
          {...(state.inventory.note && { note: state.inventory.note })}
          {...(working && { working })}
          onLink={(entries) => void link(entries)}
          onImport={(books) => void bringIn(books)}
          {...(isFiles(type) && { onRemove: (entry: ContentEntry) => void remove(entry) })}
        />
      )}
      {error && <ErrorText role="alert">{error}</ErrorText>}
      <ModalFooter>
        <Button $variant="secondary" disabled={!!working} onClick={onDone}>
          Back
        </Button>
        <Spacer />
        {!Tool && state.kind !== 'loading' && (
          <Button $variant="secondary" disabled={!!working} onClick={() => void load()}>
            {state.kind === 'failed' ? 'Try again' : 'Refresh'}
          </Button>
        )}
      </ModalFooter>
    </Modal>
  );
}

/** The contents' tabs: the books, then the device's tools. */
const Tabs = styled.div`
  display: flex;
  gap: 4px;
  margin: 0 0 12px;
  border-bottom: 1px solid var(--border);

  button {
    padding: 6px 10px;
    border: none;
    border-bottom: 2px solid transparent;
    margin-bottom: -1px;
    background: none;
    color: var(--muted);
    font: inherit;
    cursor: pointer;
  }

  button:hover {
    color: var(--text);
  }

  button[aria-selected='true'] {
    border-bottom-color: var(--highlight);
    color: var(--text);
    font-weight: 600;
  }
`;

const Group = styled.section`
  margin-top: 16px;

  h3 {
    display: flex;
    gap: 8px;
    align-items: baseline;
    margin: 0 0 4px;
    font-size: 1rem;
  }
`;

const BookRow = styled.li`
  display: flex;
  gap: 8px;
  align-items: baseline;
  padding: 6px 0;
  border-top: 1px solid var(--soft-border);

  div {
    display: flex;
    flex-direction: column;
    min-width: 0;
  }

  small {
    color: var(--muted);
    overflow-wrap: anywhere;
  }
`;

const STATUS: Record<Extract<ContentEntry, { kind: 'placed' }>['status'], string> = {
  current: 'up to date',
  update: 'the next sync sends a newer copy',
  left: 'no longer in its catalog: left there',
  changed: 'changed on the device, so left alone',
};

const byline = (book: RemoteBook, item?: Item) => {
  const author = item?.creators[0]?.name ?? book.author;
  const series = book.series && `${book.series}${book.seriesIndex ? ` #${book.seriesIndex}` : ''}`;
  return [author, series].filter(Boolean).join(' · ');
};

/**
 * What's on a connection, in groups: books the library doesn't have (to import), books it has
 * that a sync didn't send (to link), those a sync sent, and chosen books not there yet.
 */
export function ContentsView({
  type,
  contents,
  description,
  note,
  working,
  onLink,
  onImport,
  onRemove,
}: {
  type: ConnectionType;
  contents: Contents;
  description?: string;
  note?: string;
  /** The path being linked or imported now; buttons are off meanwhile. */
  working?: string;
  onLink(entries: Extract<ContentEntry, { kind: 'match' }>[]): void;
  onImport(books: RemoteBook[]): void;
  /** Deletes a book's file from the device (devices only; a catalog is only ever rewritten whole). */
  onRemove?(entry: ContentEntry): void;
}) {
  const unknown = contents.entries.filter((e): e is Extract<ContentEntry, { kind: 'unknown' }> => e.kind === 'unknown');
  const matches = contents.entries.filter((e): e is Extract<ContentEntry, { kind: 'match' }> => e.kind === 'match');
  const placed = contents.entries.filter((e): e is Extract<ContentEntry, { kind: 'placed' }> => e.kind === 'placed');
  const linkable = matches.filter((e) => e.linkable);
  const catalog = isExport(type);
  const canImport = !!type.read;
  const busy = working !== undefined;
  const title = (book: RemoteBook, item?: Item) => item?.title ?? book.title ?? fileName(book.path);
  /** Removing an entry's file, confirmed in place; a book the library doesn't have is deleted for good. */
  const removal = (entry: ContentEntry) =>
    onRemove && (
      <DeleteButton
        small
        disabled={busy}
        verb={entry.kind === 'unknown' ? 'Delete' : 'Remove'}
        onDelete={() => onRemove(entry)}
      />
    );
  const row = (key: string, book: RemoteBook, item: Item | undefined, detail: string, action?: ReactNode) => (
    <BookRow key={key}>
      <div>
        <span>
          {title(book, item)} {working === book.path && <Muted>(working…)</Muted>}
        </span>
        <small>{[byline(book, item), detail].filter(Boolean).join(' · ')}</small>
      </div>
      <Spacer />
      {action}
    </BookRow>
  );

  return (
    <>
      {description && <Muted as="p">Connected: {description}.</Muted>}
      <p>
        {contents.entries.length === 0
          ? catalog
            ? 'Nothing yet: the catalog hasn’t been written. Sync it to write it.'
            : 'No books on it.'
          : `${plural(contents.entries.length, 'book')} on it: ${[
              placed.length && `${placed.length} sent by nexlibris`,
              matches.length && `${matches.length} also in your library`,
              unknown.length && `${unknown.length} not in your library`,
            ]
              .filter(Boolean)
              .join(', ')}.`}
        {contents.pending.length > 0 && ` ${plural(contents.pending.length, 'book')} in its catalog not on it yet: the next sync adds them.`}
      </p>
      {note && <Muted as="p">{note}</Muted>}

      {canImport && unknown.length > 0 && (
        <Group>
          <h3>
            Not in your library <Spacer />
            <Button $variant="secondary" $size="small" disabled={busy} onClick={() => onImport(unknown.map((e) => e.book))}>
              Import all
            </Button>
          </h3>
          <Muted as="p">Importing copies a book into the library and keeps it on this connection.</Muted>
          <Stack as="ul">
            {unknown.map((e) =>
              row(
                e.book.path,
                e.book,
                undefined,
                e.book.path,
                <>
                  <Button $variant="secondary" $size="small" disabled={busy} onClick={() => onImport([e.book])}>
                    Import
                  </Button>
                  {removal(e)}
                </>,
              ),
            )}
          </Stack>
        </Group>
      )}

      {matches.length > 0 && (
        <Group>
          <h3>
            Also in your library <Spacer />
            {linkable.length > 0 && (
              <Button $variant="secondary" $size="small" disabled={busy} onClick={() => onLink(linkable)}>
                Link all
              </Button>
            )}
          </h3>
          <Muted as="p">
            Put there some other way. Linking keeps them on this connection and lets syncs update them. One whose library
            copy has no file the connection takes can be imported instead, adding the device’s file to it.
          </Muted>
          <Stack as="ul">
            {matches.map((e) =>
              row(
                e.book.path,
                e.book,
                e.item,
                e.book.path,
                <>
                  {e.linkable ? (
                    <Button $variant="secondary" $size="small" disabled={busy} onClick={() => onLink([e])}>
                      Link
                    </Button>
                  ) : (
                    canImport && (
                      <Button $variant="secondary" $size="small" disabled={busy} onClick={() => onImport([e.book])}>
                        Import
                      </Button>
                    )
                  )}
                  {removal(e)}
                </>,
              ),
            )}
          </Stack>
        </Group>
      )}

      {placed.length > 0 && (
        <Group>
          <h3>{catalog ? 'In the catalog' : 'Sent by nexlibris'}</h3>
          {onRemove && (
            <Muted as="p">Removing one deletes it there and takes it out of the catalog, so syncs don’t send it again.</Muted>
          )}
          <Stack as="ul">
            {placed.map((e) => row(e.book.path, e.book, e.item, e.item ? STATUS[e.status] : 'removed from the library', removal(e)))}
          </Stack>
        </Group>
      )}

      {contents.pending.length > 0 && (
        <Group>
          <h3>Not on it yet</h3>
          <Stack as="ul">
            {contents.pending.map((item) => (
              <BookRow key={item.id}>
                <div>
                  <span>{item.title}</span>
                  <small>{item.creators[0]?.name}</small>
                </div>
              </BookRow>
            ))}
          </Stack>
        </Group>
      )}
    </>
  );
}
