import type { LibraryBackend } from './backend';
import { itemExtras, planMerge, type Conflict, type MergePlan, type Side } from './merge';
import type { Operation } from './operations';
import { planRepair, stateDigest } from './repair';
import type { MessageClient, MessageImpl } from './rpc';
import { scopeChanges, scopeLibrary, scopeOf, type ScopeRule } from './scope';
import type { PeerInfo, SyncApi } from './syncApi';
import type { ItemId, Library } from './types';

/**
 * Running a sync (M6) from the instance that drives it, against a hub serving the sync API, and
 * the hub's side of that API over its library backend.
 *
 * A sync works out the merge from both libraries and what each changed since the last sync (the
 * sync base: each side's revision when they last agreed), shows it as a preview, then applies it:
 * the hub's side first (only if the hub hasn't changed since its state was fetched), then this
 * side's. Then it compares the two state hashes, and if they differ copies the parts that differ
 * from the source of truth. Every step is made of ordinary operations worked out from current
 * state, so a sync that's interrupted anywhere can just be run again.
 *
 * A hub that keeps an instance to the books its connection picks (`scope.ts`) shows it only those
 * and the ones it has. Then the sync also brings in the picked books it lacks, books deleted here
 * aren't deleted on the hub but kept off this instance (its connection excludes them), and books the
 * connection no longer picks are let go of once their files have been sent (`leaveOutside`).
 */

export type SyncClient = MessageClient<SyncApi>['sync'];

/** This instance's record of a hub it's paired with, kept in its local state. */
export interface Pairing {
  hub: { origin: string; name: string; libraryName: string };
  /** The hub's sync API, e.g. `http://192.168.0.11:47811`. */
  address: string;
  key: string;
  /** Which side wins where the two disagree: `theirs` (the hub, the default) or `ours`. */
  truth: Side;
  /** Each side's revision when they last agreed; none before the first sync. */
  base?: { ours: number; theirs: number };
  /**
   * Which books' files to keep here, as a search. No longer used: which books' files an instance
   * keeps is its connection's choice in the library now, and the client moves this there.
   */
  keepFiles?: string;
  lastSyncedAt?: string;
}

export interface SyncLocalState {
  pairings: Pairing[];
}

export const SYNC_STATE_KEY = 'sync';

/** How a first sync, with no shared history, brings the libraries together. */
export type FirstSyncMode = 'combine' | 'replace';

export interface SyncPreview {
  hub: PeerInfo;
  truth: Side;
  /** Set on a first sync: how the libraries are being brought together. */
  first?: FirstSyncMode;
  /** `ours` is applied here, `theirs` sent to the hub. */
  plan: MergePlan;
  /** This instance's revision and the hub's when the preview was made; applying checks they still hold. */
  revisions: { ours: number; theirs: number };
  /** Both libraries as they were then (the hub's as this instance sees it), e.g. to name the items in conflicts. */
  libraries: { ours: Library; theirs: Library };
  /** Set when the hub keeps this instance to its connection's books: the items it had then. */
  have?: ItemId[];
  /** When scoped: books deleted here that stay on the hub, now kept off this instance. */
  keptOff?: ItemId[];
}

export interface SyncResult {
  received: number;
  sent: number;
  conflicts: Conflict[];
  /** Parts (`item:<id>`, `device:<id>`) the check after the merge found different, and copied from the source of truth. */
  repaired: string[];
  pairing: Pairing;
  /** Items here that this instance's connection no longer picks, to let go of once their files are sent (`leaveOutside`). */
  outside: ItemId[];
}

/** Works out what a sync would do, without changing anything. */
export async function previewSync(
  local: LibraryBackend,
  hub: SyncClient,
  pairing: Pairing,
  options: { truth?: Side; first?: FirstSyncMode } = {},
): Promise<SyncPreview> {
  const truth = options.truth ?? pairing.truth;
  const info = await hub.hello(null);
  if (info.origin !== pairing.hub.origin) {
    throw new Error(`${pairing.address} is a different nexlibris instance now (${info.name}). Pair with it again.`);
  }
  if (info.schemaVersion !== (await local.getLibrary()).schemaVersion) {
    throw new Error(`${info.name} has a different version of nexlibris. Update both to the same version, then sync.`);
  }
  // A hub whose revision went backwards (restored from elsewhere, say) has lost the shared history.
  const base = pairing.base && pairing.base.theirs <= info.revision ? pairing.base : undefined;
  const library = await local.getLibrary();
  const have = Object.keys(library.items);
  const keeps = library.devices?.[library.origin]?.query;
  const remote = await hub.state({ since: base?.theirs ?? 0, have, peer: library.origin, ...(keeps !== undefined && { keeps }) });
  const revisions = { ours: library.revision, theirs: remote.library.revision };
  const libraries = { ours: library, theirs: remote.library };
  const scoped = remote.scoped ? { have } : {};

  if (!base && (options.first ?? 'combine') === 'replace') {
    // Joining: this instance becomes a copy of the hub's library (as it sees it).
    const { operations } = planRepair(remote.library, library);
    const plan = { ours: operations, theirs: [], conflicts: [] };
    return { hub: info, truth: 'theirs', first: 'replace', plan, revisions, libraries, ...scoped };
  }
  // Since the base, or on a first sync everything either side ever did: then it all counts as additions.
  let ours = (await local.getChanges(base?.ours ?? 0)).map((change) => change.op);
  // Books deleted here stay on a hub that scopes this instance: they're kept off it instead.
  const deleted = remote.scoped ? ours.filter((op) => op.type === 'removeItem' && !library.items[op.id]).map((op) => (op as { id: ItemId }).id) : [];
  if (remote.scoped) ours = ours.filter((op) => op.type !== 'removeItem');
  const plan = planMerge({ library, changes: ours }, { library: remote.library, changes: remote.changes }, truth);
  let keptOff: ItemId[] | undefined;
  if (remote.scoped) {
    keptOff = [...new Set(deleted)].filter((id) => remote.library.items[id]);
    const own = library.origin;
    if (keptOff.length && library.devices?.[own] && remote.library.devices?.[own]) {
      const exclude: Operation = { type: 'excludeDeviceItems', id: own, itemIds: keptOff };
      plan.ours.push(exclude);
      plan.theirs.push(exclude);
    }
    plan.ours.push(...missingBooks(library, remote.library, plan, new Set(keptOff)));
  }
  return { hub: info, truth, ...(!base && { first: 'combine' as const }), plan, revisions, libraries, ...scoped, ...(keptOff && { keptOff }) };
}

/**
 * Books the hub shows this instance that it lacks and the merge doesn't bring (they were there all
 * along, and only now picked for it, say), with what goes with them; not ones deleted here.
 */
function missingBooks(library: Library, hubLibrary: Library, plan: MergePlan, deleted: Set<ItemId>): Operation[] {
  const added = new Set(plan.ours.flatMap((op) => (op.type === 'addItem' ? [op.item.id] : [])));
  const removedDevices = new Set(plan.ours.flatMap((op) => (op.type === 'removeDevice' ? [op.id] : [])));
  const addedDevices = new Set(plan.ours.flatMap((op) => (op.type === 'addDevice' ? [op.device.id] : [])));
  const missing = Object.values(hubLibrary.items).filter((item) => !library.items[item.id] && !added.has(item.id) && !deleted.has(item.id));
  const ids = new Set(missing.map((item) => item.id));
  const existsAfter = (_side: Side, kind: 'item' | 'device', id: string) =>
    kind === 'item'
      ? !!library.items[id] || added.has(id) || ids.has(id)
      : !removedDevices.has(id) && (!!library.devices?.[id] || addedDevices.has(id));
  return missing.flatMap((item) => [{ type: 'addItem' as const, item }, ...itemExtras(hubLibrary, item.id, 'ours', existsAfter, new Set())]);
}

/** Applies a preview: the hub's side, this side, then the check and any repair. Returns the updated pairing too, already saved. */
export async function runSync(
  local: LibraryBackend,
  hub: SyncClient,
  pairing: Pairing,
  preview: SyncPreview,
  now: () => string = () => new Date().toISOString(),
): Promise<SyncResult> {
  const { plan, truth } = preview;
  const own = await local.getLibrary();
  const keeps = own.devices?.[own.origin]?.query;
  const scope = preview.have ? { have: preview.have, peer: own.origin, ...(keeps !== undefined && { keeps }) } : {};
  let remote = await hub.apply({ ops: plan.theirs, expectRevision: preview.revisions.theirs, ...scope });
  let library = await local.apply(plan.ours, preview.revisions.ours);

  let repaired: string[] = [];
  if (stateDigest(library).hash !== remote.hash) {
    const { library: hubLibrary } = await hub.state({ since: remote.revision, ...scope });
    if (truth === 'ours') {
      const repair = planRepair(library, hubLibrary);
      repaired = repair.parts;
      // A hub that scopes this instance keeps books deleted here (and refuses to delete them).
      const ops = preview.have ? repair.operations.filter((op) => op.type !== 'removeItem') : repair.operations;
      remote = await hub.apply({ ops, expectRevision: remote.revision, ...scope });
    } else {
      const repair = planRepair(hubLibrary, library);
      repaired = repair.parts;
      library = await local.apply(repair.operations, library.revision);
    }
    if (stateDigest(library).hash !== remote.hash) {
      throw new Error(`This library and ${preview.hub.name}'s still differ after repairing them. Try syncing again.`);
    }
  }

  const at = now();
  const updated: Pairing = { ...pairing, base: { ours: library.revision, theirs: remote.revision }, lastSyncedAt: at };
  await savePairing(local, updated);
  await hub.done({ origin: library.origin, at });
  const outside = (remote.outside ?? []).filter((id) => library.items[id]);
  return { received: plan.ours.length, sent: plan.theirs.length, conflicts: plan.conflicts, repaired, pairing: updated, outside };
}

/**
 * Lets go of books this instance's connection no longer picks (`SyncResult.outside`), once the hub
 * has their files. Their removal isn't sent back: the hub keeps them. Moves the sync base past it
 * when nothing else changed since the sync, so the next sync needn't look at it, and returns the
 * pairing as saved.
 */
export async function leaveOutside(local: LibraryBackend, pairing: Pairing, outside: ItemId[]): Promise<Pairing> {
  const before = await local.getLibrary();
  const ids = outside.filter((id) => before.items[id]);
  if (!ids.length) return pairing;
  const library = await local.apply(ids.map((id) => ({ type: 'removeItem', id })));
  if (!pairing.base || pairing.base.ours !== before.revision) return pairing;
  const updated = { ...pairing, base: { ...pairing.base, ours: library.revision } };
  await savePairing(local, updated);
  return updated;
}

/** A pairing just made, with the books whose files the hub chose for this instance (not saved with it: they go in its connection). */
export type NewPairing = Pairing & { chosenFiles?: string };

/**
 * Pairs with a hub using the one-time code it showed, and saves the pairing. Pairing again with
 * the same hub (after its address changed, say) keeps where the two last agreed.
 */
export async function pairWithHub(local: LibraryBackend, hub: SyncClient, address: string, code: string, name: string): Promise<NewPairing> {
  const library = await local.getLibrary();
  const { key, hub: info, keepFiles } = await hub.pair({ code, peer: { origin: library.origin, name } });
  const existing = (await readPairings(local)).find((p) => p.hub.origin === info.origin);
  const pairing: Pairing = {
    hub: { origin: info.origin, name: info.name, libraryName: info.libraryName },
    address,
    key,
    truth: existing?.truth ?? 'theirs',
    ...(existing?.base && { base: existing.base, lastSyncedAt: existing.lastSyncedAt }),
  };
  await savePairing(local, pairing);
  return { ...pairing, ...(keepFiles?.trim() && { chosenFiles: keepFiles.trim() }) };
}

export async function readPairings(local: LibraryBackend): Promise<Pairing[]> {
  return (await local.readLocalState<SyncLocalState>(SYNC_STATE_KEY))?.pairings ?? [];
}

/** Adds or replaces the pairing with that hub. */
export async function savePairing(local: LibraryBackend, pairing: Pairing): Promise<void> {
  const others = (await readPairings(local)).filter((p) => p.hub.origin !== pairing.hub.origin);
  await local.writeLocalState(SYNC_STATE_KEY, { pairings: [...others, pairing] } satisfies SyncLocalState);
}

export async function removePairing(local: LibraryBackend, hubOrigin: string): Promise<void> {
  const pairings = (await readPairings(local)).filter((p) => p.hub.origin !== hubOrigin);
  await local.writeLocalState(SYNC_STATE_KEY, { pairings } satisfies SyncLocalState);
}

/**
 * The hub's side of the sync API, over its library backend: `hello`, `state` and `apply`. Pairing,
 * recording finished syncs and files belong to whatever hosts it (the desktop's main process),
 * which holds the keys and the files.
 */
export function createSyncService(
  backend: LibraryBackend,
  options: {
    /** What to call this instance, e.g. the computer's name. */
    name: () => string;
    /** Called after operations from a peer are applied, e.g. to show the changes. */
    onApplied?: (library: Library) => void;
    /**
     * Keeps each instance to the books its connection picks (`scope.ts`): it sees only those and
     * the ones it has, and can't delete books here. Without it, every instance sees everything.
     */
    scope?: ScopeRule;
  },
): Omit<MessageImpl<SyncApi>['sync'], 'pair' | 'done' | 'missing'> {
  return {
    async hello() {
      const library = await backend.getLibrary();
      return {
        origin: library.origin,
        name: options.name(),
        libraryId: library.id,
        libraryName: library.name,
        schemaVersion: library.schemaVersion,
        revision: library.revision,
      };
    },
    async state({ since, peer, have, keeps }) {
      const library = await backend.getLibrary();
      // Up to the library's revision: anything applied after it was read isn't in it either.
      const changes = (await backend.getChanges(since)).filter((change) => change.revision <= library.revision).map((change) => change.op);
      if (!options.scope || !peer) return { library, changes };
      const scope = scopeOf(library, options.scope(library, peer, keeps), have);
      if (!scope) return { library, changes, scoped: true };
      return { library: scopeLibrary(library, scope), changes: scopeChanges(changes, scope), scoped: true };
    },
    async apply({ ops, expectRevision, peer, have, keeps }) {
      const scoping = options.scope && peer ? options.scope : undefined;
      // An instance the hub scopes deletes books only for itself.
      if (scoping) ops = ops.filter((op) => op.type !== 'removeItem');
      const library = await backend.apply(ops, expectRevision);
      if (ops.length) options.onApplied?.(library);
      if (!scoping) return { revision: library.revision, hash: stateDigest(library).hash };
      const keep = scoping(library, peer!, keeps);
      const scope = scopeOf(library, keep, have);
      const outside = keep ? (have ?? []).filter((id) => library.items[id] && !keep(library.items[id]!)) : [];
      return { revision: library.revision, hash: stateDigest(scope ? scopeLibrary(library, scope) : library).hash, outside };
    },
  };
}
