import {
  createDevice,
  leaveOutside,
  readPairings,
  savePairing,
  type Device,
  type HubFiles,
  type Item,
  type KeepRule,
  type Library,
  type LibraryBackend,
  type NewPairing,
  type Pairing,
  type SyncResult,
  type Operation,
  type ScopeRule,
} from '@nexlibris/common';
import { deviceItems } from '../devices/selection';
import { freeFiles, itemFiles, type Freed } from '../library/freeFiles';
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

/**
 * Connections for both sides of a pairing just made, so the other shows here now (they reach the
 * other side on the sync). This instance's keeps the files the hub chose when it showed the code,
 * if it chose (replacing an earlier choice), so even the first sync fetches only those.
 */
export function pairedConnections(library: Library, pairing: NewPairing, selfName: string): Operation[] {
  const chosen = pairing.chosenFiles;
  const own = library.devices?.[library.origin];
  return [
    ...addInstances(library, [{ origin: library.origin, name: selfName }], chosen ?? EVERY_BOOK),
    ...(own && chosen && own.query !== chosen ? [{ type: 'updateDevice' as const, id: own.id, patch: { query: chosen } }] : []),
    ...addInstances(library, [{ origin: pairing.hub.origin, name: pairing.hub.name }]),
  ];
}

/** Which items' files an instance keeps, by its connection; undefined (all of them) when it has none. */
export function keptBy(library: Library, origin: string): ((item: Item) => boolean) | undefined {
  const device = library.devices?.[origin];
  if (!device || !isInstanceConnection(device)) return undefined;
  const kept = new Set(deviceItems(library, device).map((item) => item.id));
  return (item) => kept.has(item.id);
}

/**
 * The books a hub shows an instance (`scope.ts`): those its connection picks, and every one when it
 * keeps every book's files (the connection's `has:file` doesn't leave out books without files here)
 * or has no connection and sent no rules. Books kept off it (`Device.excluded`) are left out either way.
 */
export const instanceScope: ScopeRule = (library, origin, keeps) => {
  const device = library.devices?.[origin];
  if (!device) return keeps?.trim() === EVERY_BOOK ? undefined : keepRule(keeps, library);
  if (!isInstanceConnection(device)) return undefined;
  if (device.query?.trim() === EVERY_BOOK) {
    const excluded = new Set(device.excluded);
    return excluded.size ? (item) => !excluded.has(item.id) : undefined;
  }
  return keptBy(library, origin);
};

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

/** Books let go of after a sync, as this instance's connection no longer picks them, and the space their files took. */
export interface LeftBooks extends Freed {
  books: number;
}

/**
 * After a sync and its files: lets go of the books this instance's connection no longer picks
 * (`SyncResult.outside`), those whose files and cover the hub has, and deletes their files here.
 */
export async function letGo(backend: LibraryBackend, files: HubFiles, result: SyncResult): Promise<{ pairing: Pairing; left: LeftBooks } | undefined> {
  const library = await backend.getLibrary();
  const outside = result.outside.map((id) => library.items[id]).filter((item): item is Item => !!item);
  if (!outside.length) return undefined;
  const lacking = new Set(await files.missing([...new Set(outside.flatMap(itemFiles))]));
  const gone = outside.filter((item) => !itemFiles(item).some((hash) => lacking.has(hash)));
  if (!gone.length) return undefined;
  const pairing = await leaveOutside(backend, result.pairing, gone.map((item) => item.id));
  return { pairing, left: { books: gone.length, ...(await freeFiles(backend, gone)) } };
}
