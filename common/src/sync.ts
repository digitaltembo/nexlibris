import type { LibraryBackend } from './backend';
import { planMerge, type Conflict, type MergePlan, type Side } from './merge';
import { planRepair, stateDigest } from './repair';
import type { MessageClient, MessageImpl } from './rpc';
import type { PeerInfo, SyncApi } from './syncApi';
import type { Library } from './types';

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
  /** Both libraries as they were then, e.g. to name the items in conflicts. */
  libraries: { ours: Library; theirs: Library };
}

export interface SyncResult {
  received: number;
  sent: number;
  conflicts: Conflict[];
  /** Parts (`item:<id>`, `device:<id>`) the check after the merge found different, and copied from the source of truth. */
  repaired: string[];
  pairing: Pairing;
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
  const [remote, library] = await Promise.all([hub.state({ since: base?.theirs ?? 0 }), local.getLibrary()]);
  const revisions = { ours: library.revision, theirs: remote.library.revision };
  const libraries = { ours: library, theirs: remote.library };

  if (!base && (options.first ?? 'combine') === 'replace') {
    // Joining: this instance becomes a copy of the hub's library.
    const { operations } = planRepair(remote.library, library);
    const plan = { ours: operations, theirs: [], conflicts: [] };
    return { hub: info, truth: 'theirs', first: 'replace', plan, revisions, libraries };
  }
  // Since the base, or on a first sync everything either side ever did: then it all counts as additions.
  const ours = (await local.getChanges(base?.ours ?? 0)).map((change) => change.op);
  const plan = planMerge({ library, changes: ours }, { library: remote.library, changes: remote.changes }, truth);
  return { hub: info, truth, ...(!base && { first: 'combine' as const }), plan, revisions, libraries };
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
  let remote = await hub.apply({ ops: plan.theirs, expectRevision: preview.revisions.theirs });
  let library = await local.apply(plan.ours, preview.revisions.ours);

  let repaired: string[] = [];
  if (stateDigest(library).hash !== remote.hash) {
    const { library: hubLibrary } = await hub.state({ since: remote.revision });
    if (truth === 'ours') {
      const repair = planRepair(library, hubLibrary);
      repaired = repair.parts;
      remote = await hub.apply({ ops: repair.operations, expectRevision: remote.revision });
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
  return { received: plan.ours.length, sent: plan.theirs.length, conflicts: plan.conflicts, repaired, pairing: updated };
}

/**
 * Pairs with a hub using the one-time code it showed, and saves the pairing. Pairing again with
 * the same hub (after its address changed, say) keeps where the two last agreed.
 */
export async function pairWithHub(local: LibraryBackend, hub: SyncClient, address: string, code: string, name: string): Promise<Pairing> {
  const library = await local.getLibrary();
  const { key, hub: info } = await hub.pair({ code, peer: { origin: library.origin, name } });
  const existing = (await readPairings(local)).find((p) => p.hub.origin === info.origin);
  const pairing: Pairing = {
    hub: { origin: info.origin, name: info.name, libraryName: info.libraryName },
    address,
    key,
    truth: existing?.truth ?? 'theirs',
    ...(existing?.base && { base: existing.base, lastSyncedAt: existing.lastSyncedAt }),
  };
  await savePairing(local, pairing);
  return pairing;
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
    async state({ since }) {
      const library = await backend.getLibrary();
      // Up to the library's revision: anything applied after it was read isn't in it either.
      const changes = (await backend.getChanges(since)).filter((change) => change.revision <= library.revision);
      return { library, changes: changes.map((change) => change.op) };
    },
    async apply({ ops, expectRevision }) {
      const library = await backend.apply(ops, expectRevision);
      if (ops.length) options.onApplied?.(library);
      return { revision: library.revision, hash: stateDigest(library).hash };
    },
  };
}
