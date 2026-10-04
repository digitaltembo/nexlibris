import {
  createDevice,
  readPairings,
  savePairing,
  type Device,
  type Item,
  type KeepRule,
  type Library,
  type LibraryBackend,
  type Operation,
} from '@nexlibris/common';
import { deviceItems } from '../devices/selection';
import { keepRule } from './files';

/**
 * Other instances of nexlibris as connections. Each instance the library syncs with is a
 * connection of the `nexlibris.instance` type whose id is that instance's origin, so two
 * instances that add one for the same third instance add the same connection. Its books are the
 * ones whose files that instance keeps (covers and every book's details always sync), chosen as
 * a reader's are. How this instance reaches another (the pairing) stays in its local state.
 */

export const INSTANCE_TYPE = 'nexlibris.instance';

/** The rule a new instance's connection starts with: every book's files. */
export const EVERY_BOOK = 'has:file';

export const isInstanceConnection = (device: Device) => device.type === INSTANCE_TYPE;

export interface InstanceInfo {
  origin: string;
  name: string;
}

/** Operations adding a connection for each of these instances that the library has none for. */
export function addInstances(library: Library, instances: InstanceInfo[], query = EVERY_BOOK): Operation[] {
  const seen = new Set(Object.keys(library.devices ?? {}));
  const ops: Operation[] = [];
  for (const { origin, name } of instances) {
    if (seen.has(origin)) continue;
    seen.add(origin);
    ops.push({ type: 'addDevice', device: { ...createDevice({ name, type: INSTANCE_TYPE, query }), id: origin } });
  }
  return ops;
}

/** Which items' files an instance keeps, by its connection; undefined (all of them) when it has none. */
export function keptBy(library: Library, origin: string): ((item: Item) => boolean) | undefined {
  const device = library.devices?.[origin];
  if (!device || !isInstanceConnection(device)) return undefined;
  const kept = new Set(deviceItems(library, device).map((item) => item.id));
  return (item) => kept.has(item.id);
}

/** For a folder hub: a device's connection where the library has one, else the search it recorded there. */
export const folderKeepRule: KeepRule = (peer, library) => keptBy(library, peer.origin) ?? keepRule(peer.keepFiles, library);

/**
 * Brings pairings made before instances were connections into the library: a connection for
 * this instance (keeping the files its pairings kept) and for each paired one. Does nothing once
 * they're there. `name` names this instance. Returns the library if it changed.
 */
export async function carryOverPairings(backend: LibraryBackend, name: string): Promise<Library | undefined> {
  const pairings = await readPairings(backend);
  if (!pairings.length) return undefined;
  const library = await backend.getLibrary();
  const self = { origin: library.origin, name };
  const kept = pairings.find((p) => p.keepFiles?.trim())?.keepFiles?.trim();
  const ops = [
    ...addInstances(library, [self], kept ?? EVERY_BOOK),
    ...addInstances(library, pairings.map((p) => ({ origin: p.hub.origin, name: p.hub.name }))),
  ];
  const updated = ops.length ? await backend.apply(ops) : undefined;
  for (const pairing of pairings) {
    if (pairing.keepFiles === undefined) continue;
    const { keepFiles: _, ...rest } = pairing;
    await savePairing(backend, rest);
  }
  return updated;
}
