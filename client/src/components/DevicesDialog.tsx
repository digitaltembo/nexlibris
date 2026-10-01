import { createDevice, userData, type Device, type DevicePatch } from '@nexlibris/common';
import { useEffect, useState } from 'react';
import styled from 'styled-components';
import { exportCatalog, type CatalogSink, type ExportProgress, type ExportResult } from '../devices/opds/export';
import { canWriteFolders, directorySink, zipSink } from '../devices/opds/sinks';
import { listDevice, planSync, type SyncPlan } from '../devices/plan';
import { deviceItems } from '../devices/selection';
import { runSync, type SyncProgress, type SyncResult } from '../devices/run';
import { formatLabel } from './ItemFiles';
import { useLibrary } from '../library/LibraryContext';
import { describeRule, filterFields, parseFilters } from '../library/filters';
import { filterItems } from '../library/search';
import { DEVICE_TYPES, deviceType } from '../plugins';
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

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
const fileName = (path: string) => path.slice(path.lastIndexOf('/') + 1);
const errorMessage = (e: unknown) => (e instanceof Error ? e.message : String(e));

type Screen =
  | { kind: 'list' }
  | { kind: 'edit'; device?: Device }
  | { kind: 'sync'; device: Device }
  | { kind: 'catalog'; device: Device };

/** Adding and editing devices, and syncing the items chosen for each. */
export function DevicesDialog({ onClose }: { onClose(): void }) {
  const { library } = useLibrary();
  const [screen, setScreen] = useState<Screen>({ kind: 'list' });
  const devices = Object.values(library.devices ?? {});
  const back = () => setScreen({ kind: 'list' });

  if (screen.kind === 'edit') return <EditDevice device={screen.device} onDone={back} onClose={onClose} />;
  if (screen.kind === 'sync') return <SyncDevice device={screen.device} onDone={back} onClose={onClose} />;
  if (screen.kind === 'catalog') return <ExportCatalog device={screen.device} onDone={back} onClose={onClose} />;
  return (
    <Modal title="Devices" onClose={onClose}>
      {devices.length === 0 ? (
        <Muted as="p">
          Add a reader to send books to it. Choose which books go on it by selecting them and using “Add” under Devices,
          or give it a search whose matches go on it.
        </Muted>
      ) : (
        <Stack as="ul">
          {devices.map((device) => (
            <DeviceRow key={device.id}>
              <div>
                <strong>{device.name}</strong>
                <Muted>
                  {deviceType(device.type)?.label ?? `Unknown type ${device.type}`} ·{' '}
                  {plural(deviceItems(library, device).length, 'item')}
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
                disabled={!deviceType(device.type)}
                onClick={() => setScreen({ kind: 'catalog', device })}
              >
                Catalog…
              </Button>
              <Button $size="small" disabled={!deviceType(device.type)} onClick={() => setScreen({ kind: 'sync', device })}>
                Sync…
              </Button>
            </DeviceRow>
          ))}
        </Stack>
      )}
      <ModalFooter>
        <Button $variant="secondary" onClick={() => setScreen({ kind: 'edit' })}>
          Add device
        </Button>
        <Spacer />
        <Button $variant="secondary" onClick={onClose}>
          Close
        </Button>
      </ModalFooter>
    </Modal>
  );
}

function EditDevice({ device, onDone, onClose }: { device?: Device; onDone(): void; onClose(): void }) {
  const { library, apply } = useLibrary();
  const [typeId, setTypeId] = useState(device?.type ?? DEVICE_TYPES[0]!.id);
  const [query, setQuery] = useState(device?.query ?? '');
  const [editingRules, setEditingRules] = useState(false);
  const allItems = Object.values(library.items);
  const count = (q: string) => (q.trim() ? filterItems(allItems, q, { ratings: userData(library).ratings }).length : 0);
  const matches = count(query);
  const fields = filterFields(allItems);
  const rules = query.trim() ? parseFilters(query, fields) : undefined;
  const type = deviceType(typeId);
  const [name, setName] = useState(device?.name ?? '');
  const [settings, setSettings] = useState<Record<string, string>>(() =>
    Object.fromEntries(Object.entries(device?.settings ?? {}).map(([k, v]) => [k, String(v ?? '')])),
  );

  const save = async () => {
    const values = Object.fromEntries((type?.settings ?? []).map((f) => [f.key, settings[f.key]?.trim() || undefined]));
    const label = name.trim() || type?.label || 'Device';
    if (device) {
      const patch: DevicePatch = { name: label, settings: values, query };
      await apply([{ type: 'updateDevice', id: device.id, patch }]);
    } else {
      const defined = Object.fromEntries(Object.entries(values).filter(([, v]) => v !== undefined)) as Record<string, string>;
      await apply([{ type: 'addDevice', device: createDevice({ name: label, type: typeId, settings: defined, query }) }]);
    }
    onDone();
  };

  return (
    <Modal title={device ? `Edit ${device.name}` : 'Add device'} onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <Field>
          Type
          <SmallSelect value={typeId} disabled={!!device} onChange={(e) => setTypeId(e.target.value)}>
            {DEVICE_TYPES.map((t) => (
              <option key={t.id} value={t.id}>
                {t.label}
              </option>
            ))}
          </SmallSelect>
        </Field>
        <Field>
          Name
          <input value={name} placeholder={type?.label} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field as="div">
          Also include books by rules
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
            {query.trim()
              ? `${plural(matches, 'book')} match now. Books that start or stop matching are added or removed at the next sync.`
              : 'Books matching the rules (say, a tag, or everything rated 4 stars and up) go on the device as well as the books you add to it.'}
          </small>
        </Field>
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
          </Field>
        ))}
        <ModalFooter>
          {device && (
            <DeleteButton
              what={device.name}
              onDelete={() => void apply([{ type: 'removeDevice', id: device.id }]).then(onDone)}
            />
          )}
          <Spacer />
          <Button $variant="secondary" onClick={onDone}>
            Cancel
          </Button>
          <Button type="submit">{device ? 'Save' : 'Add'}</Button>
        </ModalFooter>
      </form>
      {editingRules && (
        <FiltersDialog
          title="Books for this device"
          intro="Books matching these rules go on the device, along with any you add by hand."
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
  | { kind: 'planned'; description: string; plan: SyncPlan }
  | { kind: 'syncing'; progress: SyncProgress }
  | { kind: 'done'; result: SyncResult }
  | { kind: 'failed'; message: string };

function SyncDevice({ device, onDone, onClose }: { device: Device; onDone(): void; onClose(): void }) {
  const { library, backend, apply } = useLibrary();
  const type = deviceType(device.type)!;
  const [state, setState] = useState<SyncState>({ kind: 'connecting' });
  const title = (id: string) => library.items[id]?.title ?? 'A removed item';

  const check = async () => {
    setState({ kind: 'connecting' });
    try {
      const target = type.target(device);
      const { description } = await target.connect();
      const current = (await backend.getLibrary()).devices?.[device.id] ?? device;
      const plan = planSync(await backend.getLibrary(), current, type, await listDevice(current, type, target));
      setState({ kind: 'planned', description, plan });
    } catch (e) {
      setState({ kind: 'failed', message: errorMessage(e) });
    }
  };
  // Once, on opening. Only reads from the device, so it's harmless when StrictMode runs it twice.
  // oxlint-disable-next-line react-hooks/exhaustive-deps, react/set-state-in-effect
  useEffect(() => void check(), []);

  const sync = async (plan: SyncPlan) => {
    setState({ kind: 'syncing', progress: { done: 0, total: plan.uploads.length + plan.removals.length } });
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
    state.kind === 'planned' ? state.plan.uploads.length + state.plan.removals.length + (state.plan.catalog ? 1 : 0) : 0;
  return (
    <Modal title={`Sync ${device.name}`} onClose={busy ? () => undefined : onClose}>
      {state.kind === 'connecting' && <Muted as="p">Connecting to {device.name}…</Muted>}
      {state.kind === 'planned' && <PlanSummary description={state.description} plan={state.plan} title={title} />}
      {state.kind === 'syncing' && (
        <p role="status">
          {state.progress.current ?? 'Syncing'} ({Math.min(state.progress.done + 1, state.progress.total)} of{' '}
          {state.progress.total})…
        </p>
      )}
      {state.kind === 'done' && (
        <>
          <p role="status">
            {state.result.sent || state.result.removed
              ? `Sent ${plural(state.result.sent, 'file')}, removed ${state.result.removed}.`
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

function PlanSummary({ description, plan, title }: { description: string; plan: SyncPlan; title(id: string): string }) {
  const replacing = plan.uploads.filter((u) => u.replaces).length;
  const sending = plan.uploads.length - replacing;
  const superseded = new Set(plan.uploads.map((u) => u.supersedes));
  const removing = plan.removals.filter((path) => !superseded.has(path));
  const changes = [
    sending > 0 && `send ${plural(sending, 'book')}`,
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
      {plan.uploads.length + removing.length > 0 && (
        <List>
          {plan.uploads.map((u) => (
            <li key={u.path}>
              {fileName(u.path)}{' '}
              <Muted>
                ({u.convert ? `${formatLabel(u.convert.to)}, made from ${formatLabel(u.file.format)}` : formatLabel(u.file.format)}
                {u.supersedes ? `, replacing ${fileName(u.supersedes)}` : u.replaces && ', updated'})
              </Muted>
            </li>
          ))}
          {removing.map((path) => (
            <li key={path}>
              {fileName(path)} <Muted>(removed)</Muted>
            </li>
          ))}
        </List>
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

type ExportState =
  | { kind: 'choosing' }
  | { kind: 'exporting'; progress: ExportProgress }
  | { kind: 'done'; result: ExportResult; saved: boolean }
  | { kind: 'failed'; message: string };

/** Writing an OPDS catalog of the device's items, to a zip or a folder. */
function ExportCatalog({ device, onDone, onClose }: { device: Device; onDone(): void; onClose(): void }) {
  const { library: current, backend, apply } = useLibrary();
  const type = deviceType(device.type)!;
  const count = deviceItems(current, current.devices?.[device.id] ?? device).length;
  const [state, setState] = useState<ExportState>({ kind: 'choosing' });

  const run = async (sink: CatalogSink & { saved?: boolean }) => {
    setState({ kind: 'exporting', progress: { done: 0, total: count } });
    try {
      const library = await backend.getLibrary();
      const current = library.devices?.[device.id] ?? device;
      const result = await exportCatalog(library, current, type, backend, sink, (progress) =>
        setState({ kind: 'exporting', progress }),
      );
      if (result.operations.length) await apply(result.operations);
      setState({ kind: 'done', result, saved: sink.saved ?? true });
    } catch (e) {
      setState({ kind: 'failed', message: errorMessage(e) });
    }
  };
  const toFolder = async () => {
    let folder: FileSystemDirectoryHandle;
    try {
      folder = await window.showDirectoryPicker!({ id: `catalog-${device.id}`, mode: 'readwrite' });
    } catch {
      return; // Cancelled.
    }
    await run(directorySink(folder));
  };

  const busy = state.kind === 'exporting';
  return (
    <Modal title={`Catalog for ${device.name}`} onClose={busy ? () => undefined : onClose}>
      {state.kind === 'choosing' && (
        <Muted as="p">
          A static OPDS catalog of the {plural(count, 'item')} on this device, to host anywhere that serves
          files (it’s meant for the root of a site). Books get their current metadata and, where the device has one,
          its optimized format. Put its address in the device’s settings and the next sync adds it to the reader.
        </Muted>
      )}
      {state.kind === 'exporting' && (
        <p role="status">
          {state.progress.current ?? 'Exporting'} ({Math.min(state.progress.done + 1, state.progress.total)} of{' '}
          {state.progress.total})…
        </p>
      )}
      {state.kind === 'done' && (
        <>
          <p role="status">
            {state.saved ? `Exported ${plural(state.result.books, 'book')}` : 'Not saved'}
            {state.saved && state.result.unchanged > 0 && `; ${state.result.unchanged} file(s) were already up to date`}
            {state.saved && state.result.removed > 0 && `; removed ${state.result.removed} no longer in it`}.
          </p>
          {(state.result.skipped.length > 0 || state.result.warnings.length > 0) && (
            <List>
              {state.result.skipped.map((title) => (
                <li key={`s:${title}`}>{title}: left out, with no file in a format the device takes</li>
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
        <Spacer />
        {(state.kind === 'choosing' || state.kind === 'failed') && (
          <>
            {canWriteFolders() && (
              <Button $variant="secondary" onClick={() => void toFolder()}>
                Write to folder…
              </Button>
            )}
            <Button onClick={() => void run(zipSink(`${device.name} catalog.zip`))}>Save as zip</Button>
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
