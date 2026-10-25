import type { Device, LibraryBackend } from '@nexlibris/common';
import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { onSessionChange } from '../library/account';
import { useLibrary } from '../library/LibraryContext';
import { connectionType } from '.';
import { t } from '../i18n';

/**
 * Whether each connection is active on this device: only active ones are in the Library and can
 * be sent to. A type says how (`ConnectionTypeBase.activation`): always (OPDS servers, the static
 * export), by hand (a reader, another instance: activated while it's around, kept in local state,
 * so per device and not synced), or checked (a folder: chosen here, and still there; a served feed:
 * signed in to a server, checked again as people sign in and out).
 */

const KEY = 'active-connections';

export interface ConnectionStatus {
  active: boolean;
  /** Why it isn't active, if it isn't. */
  reason?: string;
  /** Activated and deactivated by hand. */
  manual: boolean;
}

interface Snapshot {
  /** Connections activated by hand here. */
  manual: ReadonlySet<string>;
  /** Checked connections' results: why each isn't active, or undefined where it is. */
  checked: ReadonlyMap<string, string | undefined>;
}

let snapshot: Snapshot = { manual: new Set(), checked: new Map() };
let loadedFor: LibraryBackend | undefined;
const listeners = new Set<() => void>();
const update = (next: Partial<Snapshot>) => {
  snapshot = { ...snapshot, ...next };
  listeners.forEach((listener) => listener());
};
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => void listeners.delete(listener);
};

async function load(backend: LibraryBackend) {
  if (loadedFor === backend) return;
  loadedFor = backend;
  const stored = (await backend.readLocalState<string[]>(KEY)) ?? [];
  if (loadedFor === backend) update({ manual: new Set(stored), checked: new Map() });
}

/** Checks again the connections whose type checks (a folder, after one is chosen for it). */
export async function recheckConnections(devices: Iterable<Device>): Promise<void> {
  const checked = new Map(snapshot.checked);
  let changed = false;
  for (const device of devices) {
    const activation = connectionType(device.type)?.activation;
    if (typeof activation !== 'function') continue;
    const reason = await activation(device).catch((e: unknown) => (e instanceof Error ? e.message : String(e)));
    if (!checked.has(device.id) || checked.get(device.id) !== reason) {
      checked.set(device.id, reason);
      changed = true;
    }
  }
  if (changed) update({ checked });
}

/** Activates or deactivates a connection activated by hand, on this device. */
export async function setConnectionActive(backend: LibraryBackend, id: string, active: boolean): Promise<void> {
  const manual = new Set(snapshot.manual);
  if (active) manual.add(id);
  else manual.delete(id);
  update({ manual });
  await backend.writeLocalState(KEY, [...manual]);
}

function statusIn(state: Snapshot, device: Device): ConnectionStatus {
  const type = connectionType(device.type);
  if (!type) return { active: false, reason: t('connectionTypes.unknownType'), manual: false };
  const activation = type.activation ?? 'always';
  const manual = activation === 'manual';
  const unavailable = type.unavailable?.();
  if (unavailable) return { active: false, reason: unavailable, manual };
  if (activation === 'always') return { active: true, manual };
  if (manual) return state.manual.has(device.id) ? { active: true, manual } : { active: false, reason: t('connectionTypes.notActivated'), manual };
  if (!state.checked.has(device.id)) return { active: false, reason: t('connectionTypes.checking'), manual };
  const reason = state.checked.get(device.id);
  return reason ? { active: false, reason, manual } : { active: true, manual };
}

/** A connection's status as last known, outside React (and for tests). */
export const connectionStatus = (device: Device): ConnectionStatus => statusIn(snapshot, device);

/** Each connection's status, kept current: as connections change, and as they're activated here. */
export function useConnectionStatus(): { status(device: Device): ConnectionStatus; isActive(device: Device): boolean } {
  const { library, backend } = useLibrary();
  const state = useSyncExternalStore(subscribe, () => snapshot);
  useEffect(() => void load(backend), [backend]);
  useEffect(() => {
    const recheck = () => void recheckConnections(Object.values(library.devices ?? {}));
    recheck();
    // A served feed is active while signed in.
    return onSessionChange(recheck);
  }, [library.devices]);
  return useMemo(
    () => ({ status: (device: Device) => statusIn(state, device), isActive: (device: Device) => statusIn(state, device).active }),
    [state],
  );
}
