import { catalogAuth, readCredentials, writeCredentials } from '../catalogs/credentials';
import { loadFeed } from '../catalogs/feedCache';
import { textFetcher } from '../catalogs/remote';
import { sourceOf } from '../catalogs/sources';
import { CatalogBrowser } from './CatalogBrowser';
import { createDevice, readPairings, removePairing, userData, type Device, type DevicePatch, type FirstSyncMode, type Item, type Library, type NewPairing, type Pairing } from '@nexlibris/common';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
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
import { deviceItems } from '../devices/selection';
import { runSync, type SyncProgress, type SyncResult } from '../devices/run';
import { isCatalog, isDevice, isInstance, isSource, type CatalogType, type ConnectionType, type DeviceType, type Inventory, type RemoteBook, type SettingField } from '../devices/types';
import { formatLabel } from './ItemFiles';
import { useLibrary } from '../library/LibraryContext';
import { describeRule, filterFields, parseFilters } from '../library/filters';
import { filterItems } from '../library/search';
import { CONNECTION_TYPES, connectionType } from '../plugins';
import { canSync, transportOf } from '../sync/connect';
import { folderKey } from '../sync/folder';
import { instanceName } from '../sync/hub';
import { carryOverPairings, isInstanceConnection, pairedConnections } from '../sync/instances';
import { Hosting, PairChoices, PairScreen, SyncInstance, transportLabel, type PairHow } from './InstanceSync';
import { Button, Muted, SmallSelect, Spacer, Stack, Tag, TagLabel, TagList } from '../styles/ui';
import { DeleteButton } from './DeleteButton';
import { FiltersDialog } from './FiltersDialog';
import { Modal, ModalFooter } from './Modal';

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
  | { kind: 'contents'; device: Device }
  /** Choosing how to pair with another instance, then pairing that way: to add it, or to reach it from here. */
  | { kind: 'connect' }
  | { kind: 'pair'; how: PairHow }
  /** `start`: preview straight away (just after pairing), with this first-sync choice. */
  | { kind: 'instance'; device: Device; pairing: Pairing; start?: { first: FirstSyncMode } };

const when = (iso: string | undefined) => (iso ? new Date(iso).toLocaleString() : 'never');

/** Other instances first, this one leading them, then readers and catalogs as they were added. */
const order = (origin: string) => (device: Device) => (device.id === origin ? 0 : isInstanceConnection(device) ? 1 : 2);

/**
 * Connections: where the library goes. A reader that books are copied to, an OPDS catalog written
 * out for hosting, or another instance of nexlibris that the library syncs with. (The library
 * stores them as devices.) Adding and editing them, syncing each, and seeing what's on each; and,
 * in the apps, letting other instances connect to this one.
 */
export function ConnectionsDialog({ onClose }: { onClose(): void }) {
  const { library, backend, refresh } = useLibrary();
  const [screen, setScreen] = useState<Screen>({ kind: 'list' });
  /** How this instance reaches others: kept here, not in the library. */
  const [pairings, setPairings] = useState<Pairing[]>([]);
  const loadPairings = useCallback(() => void readPairings(backend).then(setPairings), [backend]);
  useEffect(() => {
    void carryOverPairings(backend, instanceName())
      .then((changed) => changed && refresh())
      .finally(loadPairings);
  }, [backend, refresh, loadPairings]);
  const sortKey = order(library.origin);
  const devices = Object.values(library.devices ?? {}).sort((a, b) => sortKey(a) - sortKey(b));
  const back = () => (loadPairings(), setScreen({ kind: 'list' }));
  const pairingOf = (device: Device) => pairings.find((p) => p.hub.origin === device.id);

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
  if (screen.kind === 'contents') return <ConnectionContents device={screen.device} onDone={back} onClose={onClose} />;
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
  if (screen.kind === 'instance') {
    return (
      <SyncInstance
        device={screen.device}
        pairing={screen.pairing}
        {...(screen.start && { start: screen.start })}
        self={instanceName()}
        onBack={back}
        onClose={onClose}
      />
    );
  }
  if (screen.kind === 'sync') {
    const type = connectionType(screen.device.type)!;
    return isCatalog(type) ? (
      <SyncCatalog device={screen.device} type={type} onDone={back} onClose={onClose} />
    ) : isDevice(type) ? (
      <SyncDevice device={screen.device} type={type} onDone={back} onClose={onClose} />
    ) : null;
  }
  return (
    <Modal title="Connections" onClose={onClose}>
      {devices.length === 0 ? (
        <Muted as="p">
          Add a reader to send books to it, an OPDS catalog to publish them, or nexlibris on another device to sync the
          library with it. Choose which books go on each by selecting them and using “Add” under Connections, or give it
          rules whose matches go on it.
        </Muted>
      ) : (
        <Stack as="ul">
          {devices.map((device) => {
            const books = plural(deviceItems(library, device).length, 'book');
            if (isInstanceConnection(device)) {
              const self = device.id === library.origin;
              const pairing = pairingOf(device);
              return (
                <DeviceRow key={device.id}>
                  <div>
                    <strong>{device.name}</strong>
                    <Muted>
                      {self
                        ? `This device · gets ${books}`
                        : `nexlibris · ${pairing ? `${transportLabel(pairing)}, last synced ${when(pairing.lastSyncedAt)}` : 'not paired from here'} · gets ${books}`}
                    </Muted>
                  </div>
                  <Spacer />
                  <Button $variant="secondary" $size="small" onClick={() => setScreen({ kind: 'edit', device })}>
                    Edit
                  </Button>
                  {!self &&
                    (pairing ? (
                      <Button $size="small" onClick={() => setScreen({ kind: 'instance', device, pairing })}>
                        Sync…
                      </Button>
                    ) : (
                      canSync() && (
                        <Button $variant="secondary" $size="small" onClick={() => setScreen({ kind: 'connect' })}>
                          Pair…
                        </Button>
                      )
                    ))}
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
            return (
              <DeviceRow key={device.id}>
                <div>
                  <strong>{device.name}</strong>
                  <Muted>
                    {connectionType(device.type)?.label ?? `Unknown type ${device.type}`} · {books}
                    {device.query && ` (search: “${device.query}”)`}
                    {device.lastSyncedAt && ` · synced ${new Date(device.lastSyncedAt).toLocaleString()}`}
                  </Muted>
                </div>
                <Spacer />
                <Button $variant="secondary" $size="small" onClick={() => setScreen({ kind: 'edit', device })}>
                  Edit
                </Button>
                <Button
                  $variant="secondary"
                  $size="small"
                  disabled={!connectionType(device.type)}
                  onClick={() => setScreen({ kind: 'contents', device })}
                >
                  On it…
                </Button>
                <Button $size="small" disabled={!connectionType(device.type)} onClick={() => setScreen({ kind: 'sync', device })}>
                  Sync…
                </Button>
              </DeviceRow>
            );
          })}
        </Stack>
      )}
      <Hosting />
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

const DEVICE_TYPES = CONNECTION_TYPES.filter(isDevice);
const CATALOG_TYPES = CONNECTION_TYPES.filter(isCatalog);
const INSTANCE_TYPES = CONNECTION_TYPES.filter(isInstance);
const SOURCE_TYPES = CONNECTION_TYPES.filter(isSource);

/** Words for what a kind of connection holds, for the rules. */
const RULES_TEXT = {
  device: { label: 'Also include books by rules', what: 'device' },
  catalog: { label: 'Also include books by rules', what: 'catalog' },
  instance: { label: 'Books it gets', what: 'device' },
};

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
  const [editingRules, setEditingRules] = useState(false);
  const allItems = Object.values(library.items);
  const count = (q: string) => (q.trim() ? filterItems(allItems, q, { ratings: userData(library).ratings }).length : 0);
  const matches = count(query);
  const fields = filterFields(allItems);
  const rules = query.trim() ? parseFilters(query, fields) : undefined;
  const type = connectionType(typeId);
  const instance = !!type && isInstance(type);
  // A catalog that's browsed takes no books, so has no rules.
  const source = !!type && isSource(type);
  const kind = !type ? 'device' : isCatalog(type) ? 'catalog' : instance ? 'instance' : 'device';
  const { what } = RULES_TEXT[kind];
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
    const values = Object.fromEntries((type?.settings ?? []).map((f) => [f.key, settings[f.key]?.trim() || undefined]));
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
    if (type && isSource(type) && id) {
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
            <optgroup label="Readers">
              {DEVICE_TYPES.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.label}
                </option>
              ))}
            </optgroup>
            <optgroup label="Catalogs">
              {CATALOG_TYPES.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.label}
                </option>
              ))}
            </optgroup>
            <optgroup label="Sync">
              {INSTANCE_TYPES.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.label}
                </option>
              ))}
            </optgroup>
            <optgroup label="Browse">
              {SOURCE_TYPES.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.label}
                </option>
              ))}
            </optgroup>
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
        <Field as="div">
          {RULES_TEXT[kind].label}
          {query.trim() && (
            <TagList>
              {rules && rules.any && rules.rules.length > 1 && <Muted>Any of:</Muted>}
              {rules ? (
                rules.rules.map((rule, i) => (
                  <Tag key={i}>
                    <TagLabel>{describeRule(rule, fields)}</TagLabel>
                  </Tag>
                ))
              ) : (
                <Tag>
                  <TagLabel>{query}</TagLabel>
                </Tag>
              )}
            </TagList>
          )}
          <div>
            <Button $variant="secondary" $size="small" onClick={() => setEditingRules(true)}>
              {query.trim() ? 'Edit rules…' : 'Add rules…'}
            </Button>
          </div>
          <small>
            {instance
              ? `${self ? 'This device' : device!.name} gets the books matching these rules, and books you add to it: their details, covers and files. It doesn’t see the others, and books deleted there stay on the device it syncs with. (Through a sync folder, every book’s details go there, and only these books’ files.)${query.trim() ? ` ${plural(matches, 'book')} match now.` : ''}`
              : query.trim()
                ? `${plural(matches, 'book')} match now. Books that start or stop matching are added or removed at the next sync.`
                : `Books matching the rules (say, a tag, or everything rated 4 stars and up) go in the ${what} as well as the books you add to it.`}
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
          <Field key={field.key}>
            {field.label}
            {field.choices ? (
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
          <Button type="submit" disabled={source && !!type?.settings.some((f) => f.check?.(settings[f.key] ?? f.default, settings, library).problems?.length)}>
            {device ? 'Save' : 'Add'}
          </Button>
        </ModalFooter>
          </>
        )}
      </form>
      {editingRules && (
        <FiltersDialog
          title={instance ? `Books ${device?.name ?? 'it'} gets` : `Books for this ${what}`}
          intro={
            instance
              ? 'Books matching these rules have their files kept there, along with any you add by hand.'
              : `Books matching these rules go in the ${what}, along with any you add by hand.`
          }
          query={query}
          onChange={setQuery}
          onClose={() => setEditingRules(false)}
          items={allItems}
          count={count}
        />
      )}
    </Modal>
  );
}

type SyncState =
  | { kind: 'connecting' }
  | { kind: 'planned'; description: string; plan: SyncPlan; library: Library; listing: DeviceListing; keepFound: boolean }
  | { kind: 'syncing'; progress: SyncProgress }
  | { kind: 'done'; result: SyncResult }
  | { kind: 'failed'; message: string };

function SyncDevice({ device, type, onDone, onClose }: { device: Device; type: DeviceType; onDone(): void; onClose(): void }) {
  const { library, backend, apply } = useLibrary();
  const [state, setState] = useState<SyncState>({ kind: 'connecting' });
  const title = (id: string) => library.items[id]?.title ?? 'A removed item';

  const check = async () => {
    setState({ kind: 'connecting' });
    try {
      const target = type.target(device);
      const { description } = await target.connect();
      const library = await backend.getLibrary();
      const current = library.devices?.[device.id] ?? device;
      const listed = await listDevice(current, type, target, library);
      // The whole device, to find copies of chosen books outside the folders a sync lists.
      const found = type.inventory ? (await type.inventory(current, target, library, listed.files)).books : undefined;
      const listing = { ...listed, ...(found && { found }) };
      setState({ kind: 'planned', description, plan: planSync(library, current, type, listing), library, listing, keepFound: true });
    } catch (e) {
      setState({ kind: 'failed', message: errorMessage(e) });
    }
  };
  // Once, on opening. Only reads from the device, so it's harmless when StrictMode runs it twice.
  // oxlint-disable-next-line react-hooks/exhaustive-deps, react/set-state-in-effect
  useEffect(() => void check(), []);

  const sync = async (plan: SyncPlan) => {
    setState({ kind: 'syncing', progress: { done: 0, total: plan.moves.length + plan.uploads.length + plan.removals.length } });
    try {
      const result = await runSync(device.id, plan, type.target(device), backend, type.prepare, (progress) =>
        setState({ kind: 'syncing', progress }),
      );
      await apply(result.operations);
      setState({ kind: 'done', result });
    } catch (e) {
      setState({ kind: 'failed', message: errorMessage(e) });
    }
  };

  const busy = state.kind === 'connecting' || state.kind === 'syncing';
  const work =
    state.kind === 'planned'
      ? state.plan.uploads.length + state.plan.moves.length + state.plan.kept.length + state.plan.removals.length + (state.plan.catalog ? 1 : 0)
      : 0;
  return (
    <Modal title={`Sync ${device.name}`} onClose={busy ? () => undefined : onClose}>
      {state.kind === 'connecting' && <Muted as="p">Connecting to {device.name}…</Muted>}
      {state.kind === 'planned' && (
        <PlanSummary
          description={state.description}
          plan={state.plan}
          title={title}
          keepFound={state.keepFound}
          onKeepFound={(keepFound) => {
            const current = state.library.devices?.[device.id] ?? device;
            setState({ ...state, keepFound, plan: planSync(state.library, current, type, state.listing, { keepFound }) });
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
              ? `Sent ${plural(state.result.sent, 'file')}${state.result.moved ? `, moved ${state.result.moved}` : ''}${state.result.kept ? `, kept ${state.result.kept} already there` : ''}, removed ${state.result.removed}.`
              : !state.result.catalogAdded && 'Nothing needed doing.'}
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

      <ModalFooter>
        <Button $variant="secondary" disabled={busy} onClick={onDone}>
          Back
        </Button>
        <Spacer />
        {state.kind === 'failed' && <Button onClick={() => void check()}>Try again</Button>}
        {state.kind === 'planned' && (
          <Button disabled={work === 0} onClick={() => void sync(state.plan)}>
            {work === 0 ? 'Up to date' : 'Sync'}
          </Button>
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
  const superseded = new Set(plan.uploads.map((u) => u.supersedes));
  const removing = plan.removals.filter((path) => !superseded.has(path));
  const changes = [
    sending > 0 && `send ${plural(sending, 'book')}`,
    plan.kept.length > 0 && `keep ${plan.kept.length === 1 ? '1 copy' : `${plan.kept.length} copies`} already there`,
    plan.moves.length > 0 && `move ${plan.moves.length} to ${plan.moves.length === 1 ? 'its new place' : 'their new places'}`,
    replacing > 0 && `update ${replacing}`,
    removing.length > 0 && `remove ${removing.length} no longer chosen`,
  ].filter(Boolean);
  return (
    <>
      <Muted as="p">Connected: {description}.</Muted>
      <p>
        {changes.length ? `Will ${changes.join(', ')}.` : 'Everything chosen is already on the device.'}
        {plan.catalog && ` Will add the catalog at ${plan.catalog.url} to the reader’s OPDS libraries.`}
        {plan.unchanged > 0 && changes.length > 0 && ` ${plan.unchanged} already there.`}
      </p>
      {plan.uploads.length + plan.moves.length + removing.length > 0 && (
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
                ({u.convert ? `${formatLabel(u.convert.to)}, made from ${formatLabel(u.file.format)}` : formatLabel(u.file.format)}
                {u.supersedes ? `, replacing ${fileName(u.supersedes)}` : u.replaces && ', updated'})
              </Muted>
            </li>
          ))}
          {plan.kept.map((k) => (
            <li key={k.path}>
              {fileName(k.path)} <Muted>(already there, kept)</Muted>
            </li>
          ))}
          {removing.map((path) => (
            <li key={path}>
              {fileName(path)} <Muted>(removed)</Muted>
            </li>
          ))}
        </List>
      )}
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
 * Syncing a catalog: writing it again, to the folder it was last written to on this computer
 * (only what changed is copied, and what's no longer in it removed), or to a zip where the
 * browser can't write folders (the Android app, Firefox, Safari).
 */
function SyncCatalog({ device, type, onDone, onClose }: { device: Device; type: CatalogType; onDone(): void; onClose(): void }) {
  const { library: current, backend, apply } = useLibrary();
  const count = deviceItems(current, current.devices?.[device.id] ?? device).length;
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
      const library = await backend.getLibrary();
      const latest = library.devices?.[device.id] ?? device;
      const result = await exportCatalog(library, latest, type, backend, sink, (progress) =>
        setState({ kind: 'exporting', progress, ...(to && { folder: to }) }),
      );
      const saved = sink.saved ?? true;
      // What the catalog now holds, for "On it…" and the last sync time.
      const gone = Object.keys(latest.placed).filter((path) => !result.placed[path]);
      await apply([...result.operations, ...(saved ? [{ type: 'recordDeviceSync' as const, id: device.id, placed: result.placed, removed: gone }] : [])]);
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
          site){url && <>, at {url}</>}. Books get their current metadata
          {type.makes && ', and the optimized copy is made where a book lacks one'}.{' '}
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
            {state.saved && state.result.removed > 0 && `; removed ${state.result.removed} no longer in it`}
            {state.saved && state.folder && ` in “${state.folder.name}”`}.
          </p>
          {(state.result.skipped.length > 0 || state.result.warnings.length > 0) && (
            <List>
              {state.result.skipped.map((title) => (
                <li key={`s:${title}`}>{title}: left out, with no file in a format the catalog takes</li>
              ))}
              {state.result.warnings.map((w) => (
                <li key={`w:${w.title}`}>
                  {w.title}: {w.message}
                </li>
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

/** What's on a connection: read from the device (or, for a catalog, what its last export wrote), then shown with `ContentsView`. */
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

function ConnectionContents({ device, onDone, onClose }: { device: Device; onDone(): void; onClose(): void }) {
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
      if (!isDevice(type)) {
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
      if (!isDevice(type)) return;
      await type.target(device).remove(book.path);
      const latest = await backend.getLibrary();
      const ops = removeOperations(latest, latest.devices?.[device.id] ?? device, entry);
      if (ops.length) await backend.apply(ops);
      setState((s) => (s.kind === 'ready' ? { ...s, inventory: { ...s.inventory, books: s.inventory.books.filter((b) => b.path !== book.path) } } : s));
    });
  const bringIn = (books: RemoteBook[]) =>
    act(books, async (book) => {
      if (!isDevice(type)) return;
      const latest = (await backend.getLibrary()).devices?.[device.id] ?? device;
      await importFromConnection(backend, latest, type, type.target(device), book);
    });

  const tools = isDevice(type) ? (type.tools ?? []) : [];
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
      {!Tool && state.kind === 'loading' && <Muted as="p">{isCatalog(type) ? 'Reading…' : `Connecting to ${device.name}…`}</Muted>}
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
          {...(isDevice(type) && { onRemove: (entry: ContentEntry) => void remove(entry) })}
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
  remove: 'no longer chosen: the next sync removes it',
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
  const catalog = isCatalog(type);
  const canImport = !catalog;
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
        {contents.pending.length > 0 && ` ${plural(contents.pending.length, 'chosen book')} not on it yet: the next sync adds them.`}
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
            <Muted as="p">Removing one deletes it from the device and takes it off this connection, so syncs don’t send it again.</Muted>
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
