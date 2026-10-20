import type { LibraryBackend } from './backend';
import { itemExtras, planMerge, type Conflict, type MergePlan, type Side } from './merge';
import type { Operation } from './operations';
import { planRepair, stateDigest } from './repair';
import type { MessageClient, MessageImpl } from './rpc';
import { scopeChanges, scopeLibrary, scopeOf, type ScopeRule } from './scope';
import type { PeerInfo, SyncApi } from './syncApi';
import type { Item, ItemId, Library } from './types';

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
 * Each side exposes to the other only the books in its connection's catalog for it (M13): a hub
 * that scopes an instance (`scope.ts`) shows it only those and the ones it has, and the instance
 * sends the hub only its own catalog's books (`SyncOptions.expose`), offering the rest of them for
 * the hub to ask for (`SyncPreview.offer`). Books only one side has move by the sync's `pull` and
 * `push`, so Sync from and Sync to are the same sync; books both have merge. Deletions never cross.
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

/**
 * Which books a sync moves where neither side has them yet: every one the other side exposes
 * (`all`), none (`none`, a sync that only merges the books both have), or just these.
 */
export type SyncChoice = 'all' | 'none' | ItemId[];

export interface SyncOptions {
  truth?: Side;
  first?: FirstSyncMode;
  /** The hub's books this instance lacks to bring here: all it exposes by default (Sync from), none for Sync to. */
  pull?: SyncChoice;
  /** This instance's books the hub lacks to send it: all it exposes by default (Sync to), none for Sync from. */
  push?: SyncChoice;
  /**
   * What this instance exposes to the hub, its connection's catalog for it (as `createSyncService`'s
   * `scope` is for the hub); every book without it. Only exposed books are sent, or offered.
   */
  expose?: ScopeRule;
}

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
  /** The items this instance had then, which the hub shows it whatever its catalog. */
  have: ItemId[];
  /** Books brought here, and sent there. */
  pulled: ItemId[];
  pushed: ItemId[];
  /** The books both sides hold once it's applied, whose state the check after it compares. */
  shared: ItemId[];
  /** Books this instance exposes that the hub lacks and that aren't sent, offered to it to browse and ask for. */
  offer: Item[];
  /** Books deleted here that the hub still has: kept there, and kept off this instance (its connection there excludes them). */
  keptOff?: ItemId[];
  /** Books the hub deleted that this instance still has: kept here, and not sent there again by a sync. */
  keptHere?: ItemId[];
}

export interface SyncResult {
  received: number;
  sent: number;
  conflicts: Conflict[];
  /** Parts (`item:<id>`, `device:<id>`) the check after the merge found different, and copied from the source of truth. */
  repaired: string[];
  pairing: Pairing;
  /** As in the preview: books brought here and sent there, and those both sides hold, whose files may move. */
  pulled: ItemId[];
  pushed: ItemId[];
  shared: ItemId[];
}

const chosen = (choice: SyncChoice, all: Iterable<ItemId>): Set<ItemId> =>
  choice === 'none' ? new Set() : choice === 'all' ? new Set(all) : new Set(choice);

/**
 * Works out what a sync would do, without changing anything. Books both sides have merge as M6
 * merges them; books only one side has move by `pull` and `push`, and only those the side that has
 * them exposes. Deletions never cross: a book deleted on one side stays on the other, and is kept
 * off the side that deleted it (its connection there excludes it), so syncs don't bring it back.
 */
export async function previewSync(local: LibraryBackend, hub: SyncClient, pairing: Pairing, options: SyncOptions = {}): Promise<SyncPreview> {
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
  const hubIds = Object.keys(remote.library.items);
  const own = library.origin;
  const hubOrigin = info.origin;

  if (!base && (options.first ?? 'combine') === 'replace') {
    // Joining: this instance becomes a copy of the hub's library (as it sees it).
    const { operations } = planRepair(remote.library, library);
    const plan = { ours: operations, theirs: [], conflicts: [] };
    return { hub: info, truth: 'theirs', first: 'replace', plan, revisions, libraries, have, pulled: hubIds, pushed: [], shared: hubIds, offer: [] };
  }
  // Since the base, or on a first sync everything either side ever did: then it all counts as additions.
  const ours = (await local.getChanges(base?.ours ?? 0)).map((change) => change.op);
  // Deletions stay where they were made.
  const deletedHere = new Set(ours.filter((op) => op.type === 'removeItem' && !library.items[op.id]).map((op) => (op as { id: ItemId }).id));
  const deletedThere = new Set(remote.changes.filter((op) => op.type === 'removeItem' && !remote.library.items[op.id]).map((op) => (op as { id: ItemId }).id));
  const notRemoving = (op: Operation) => op.type !== 'removeItem';
  const plan = planMerge({ library, changes: ours.filter(notRemoving) }, { library: remote.library, changes: remote.changes.filter(notRemoving) }, truth);
  const keptOff = [...deletedHere].filter((id) => remote.library.items[id]);
  const keptHere = [...deletedThere].filter((id) => library.items[id]);
  const keepOff = (device: string, itemIds: ItemId[]) => {
    if (!itemIds.length || !library.devices?.[device] || !remote.library.devices?.[device]) return;
    const exclude: Operation = { type: 'excludeDeviceItems', id: device, itemIds };
    plan.ours.push(exclude);
    plan.theirs.push(exclude);
  };
  keepOff(own, keptOff);
  keepOff(hubOrigin, keptHere);

  // What moves where only one side has it.
  const exposedRule = options.expose?.(library, hubOrigin);
  const exposed = (id: ItemId) => !exposedRule || (!!library.items[id] && exposedRule(library.items[id]!));
  const kept = new Set(keptHere);
  const hubHas = new Set(hubIds);
  const explicitPush = Array.isArray(options.push);
  const pushed = [...chosen(options.push ?? 'all', have), ...(remote.requested ?? [])].filter(
    (id) => library.items[id] && !hubHas.has(id) && exposed(id) && (explicitPush || !kept.has(id)),
  );
  const pulled = [...chosen(options.pull ?? 'all', hubIds)].filter((id) => remote.library.items[id] && !library.items[id] && !deletedHere.has(id));
  const ourScope = new Set([...have, ...pulled]);
  const theirScope = new Set([...hubIds, ...pushed]);
  plan.ours = [...scopeChanges(plan.ours, ourScope), ...missingBooks(library, remote.library, plan.ours, 'ours', pulled)];
  plan.theirs = [...scopeChanges(plan.theirs, theirScope), ...missingBooks(remote.library, library, plan.theirs, 'theirs', pushed)];
  const shared = [...ourScope].filter((id) => theirScope.has(id));
  const offered = new Set(pushed);
  const offer = have.filter((id) => !hubHas.has(id) && !offered.has(id) && !kept.has(id) && exposed(id)).map((id) => library.items[id]!);
  return {
    hub: info,
    truth,
    ...(!base && { first: 'combine' as const }),
    plan,
    revisions,
    libraries,
    have,
    pulled: [...new Set(pulled)],
    pushed: [...new Set(pushed)],
    shared,
    offer,
    ...(keptOff.length && { keptOff }),
    ...(keptHere.length && { keptHere }),
  };
}

/**
 * The books one side takes from the other that the merge doesn't bring (they were there all along,
 * say, and only now chosen), with what goes with them. `to` is the side taking them, `ops` what the
 * merge already gives it.
 */
function missingBooks(to: Library, from: Library, ops: Operation[], side: Side, ids: ItemId[]): Operation[] {
  const added = new Set(ops.flatMap((op) => (op.type === 'addItem' ? [op.item.id] : [])));
  const removedDevices = new Set(ops.flatMap((op) => (op.type === 'removeDevice' ? [op.id] : [])));
  const addedDevices = new Set(ops.flatMap((op) => (op.type === 'addDevice' ? [op.device.id] : [])));
  const missing = ids.map((id) => from.items[id]!).filter((item) => item && !to.items[item.id] && !added.has(item.id));
  const taking = new Set(missing.map((item) => item.id));
  const existsAfter = (_side: Side, kind: 'item' | 'device', id: string) =>
    kind === 'item'
      ? !!to.items[id] || added.has(id) || taking.has(id)
      : !removedDevices.has(id) && (!!to.devices?.[id] || addedDevices.has(id));
  return missing.flatMap((item) => [{ type: 'addItem' as const, item }, ...itemExtras(from, item.id, side, existsAfter, new Set())]);
}

/** The library cut down to `ids`, for comparing the books both sides hold. */
const sharedPart = (library: Library, ids: ItemId[]) => scopeLibrary(library, new Set(ids.filter((id) => library.items[id])));

/** Applies a preview: the hub's side, this side, then the check and any repair. Returns the updated pairing too, already saved. */
export async function runSync(
  local: LibraryBackend,
  hub: SyncClient,
  pairing: Pairing,
  preview: SyncPreview,
  now: () => string = () => new Date().toISOString(),
): Promise<SyncResult> {
  const { plan, truth, shared } = preview;
  const own = await local.getLibrary();
  const keeps = own.devices?.[own.origin]?.query;
  const scope = { have: preview.have, peer: own.origin, ...(keeps !== undefined && { keeps }) };
  let remote = await hub.apply({ ops: plan.theirs, expectRevision: preview.revisions.theirs, compare: shared, offer: preview.offer, ...scope });
  let library = await local.apply(plan.ours, preview.revisions.ours);

  let repaired: string[] = [];
  if (stateDigest(sharedPart(library, shared)).hash !== remote.hash) {
    const { library: hubView } = await hub.state({ since: remote.revision, ...scope, have: shared });
    const ours = sharedPart(library, shared);
    const theirs = sharedPart(hubView, shared);
    // Only the books both hold are compared, so a repair never removes one (deletions don't cross).
    const notRemoving = (op: Operation) => op.type !== 'removeItem';
    if (truth === 'ours') {
      const repair = planRepair(ours, theirs);
      repaired = repair.parts;
      remote = await hub.apply({ ops: repair.operations.filter(notRemoving), expectRevision: remote.revision, compare: shared, ...scope });
    } else {
      const repair = planRepair(theirs, ours);
      repaired = repair.parts;
      library = await local.apply(repair.operations.filter(notRemoving), library.revision);
    }
    if (stateDigest(sharedPart(library, shared)).hash !== remote.hash) {
      throw new Error(`This library and ${preview.hub.name}'s still differ after repairing them. Try syncing again.`);
    }
  }

  const at = now();
  const updated: Pairing = { ...pairing, base: { ours: library.revision, theirs: remote.revision }, lastSyncedAt: at };
  await savePairing(local, updated);
  await hub.done({ origin: library.origin, at });
  return {
    received: plan.ours.length,
    sent: plan.theirs.length,
    conflicts: plan.conflicts,
    repaired,
    pairing: updated,
    pulled: preview.pulled,
    pushed: preview.pushed,
    shared,
  };
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
 * What instances that sync with this one as their hub offer it (`SyncPreview.offer`): the books
 * each exposes to it that it lacks, as of its last sync, and which of them were asked for here, to
 * come with its next sync. Kept in local state, not the library.
 */
export interface OfferState {
  peers: Record<string, { items: Item[]; requested: ItemId[]; at: string }>;
}

export const SYNC_OFFERS_KEY = 'sync-offers';

const readOffers = async (backend: LibraryBackend) => (await backend.readLocalState<OfferState>(SYNC_OFFERS_KEY)) ?? { peers: {} };

/** The books an instance that syncs with this one offers it, and which were asked for. */
export async function peerOffer(backend: LibraryBackend, peer: string): Promise<{ items: Item[]; requested: ItemId[]; at?: string }> {
  return (await readOffers(backend)).peers[peer] ?? { items: [], requested: [] };
}

/** Asks for books an instance offers (or stops asking, with `ask` false): they come with its next sync. */
export async function requestFromPeer(backend: LibraryBackend, peer: string, ids: ItemId[], ask = true): Promise<void> {
  const state = await readOffers(backend);
  const offer = state.peers[peer] ?? { items: [], requested: [], at: new Date(0).toISOString() };
  const requested = ask ? [...new Set([...offer.requested, ...ids])] : offer.requested.filter((id) => !ids.includes(id));
  await backend.writeLocalState(SYNC_OFFERS_KEY, { peers: { ...state.peers, [peer]: { ...offer, requested } } } satisfies OfferState);
}

/**
 * The hub's side of the sync API, over its library backend: `hello`, `state`, `apply` and `allows`.
 * Pairing, recording finished syncs and files belong to whatever hosts it (the desktop's main
 * process), which holds the keys and the files.
 */
export function createSyncService(
  backend: LibraryBackend,
  options: {
    /** What to call this instance, e.g. the computer's name. */
    name: () => string;
    /** Called after operations from a peer are applied, e.g. to show the changes. */
    onApplied?: (library: Library) => void;
    /**
     * Keeps each instance to the books its connection's catalog holds (`scope.ts`): it sees only
     * those and the ones it has, and fetches only their files. Without it, every instance sees everything.
     */
    scope?: ScopeRule;
  },
): Omit<MessageImpl<SyncApi>['sync'], 'pair' | 'done' | 'missing'> {
  /** The items each instance said it had when it last asked for the state, which it may fetch the files of. */
  const had = new Map<string, ItemId[]>();
  const viewOf = (library: Library, peer: string | undefined, have: ItemId[] | undefined, keeps?: string) =>
    options.scope && peer ? scopeOf(library, options.scope(library, peer, keeps), have) : undefined;
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
      if (peer && have) had.set(peer, have);
      const requested = peer ? (await peerOffer(backend, peer)).requested.filter((id) => !library.items[id]) : [];
      const asked = requested.length ? { requested } : {};
      if (!options.scope || !peer) return { library, changes, ...asked };
      const scope = viewOf(library, peer, have, keeps);
      if (!scope) return { library, changes, scoped: true, ...asked };
      // Deletions of books it has are among the changes it sees, though the books aren't in the library.
      const changed = new Set([...scope, ...(have ?? [])]);
      return { library: scopeLibrary(library, scope), changes: scopeChanges(changes, changed), scoped: true, ...asked };
    },
    async apply({ ops, expectRevision, peer, have, keeps, compare, offer }) {
      // Deletions don't cross: an instance deletes books only for itself.
      if (peer) ops = ops.filter((op) => op.type !== 'removeItem');
      const library = await backend.apply(ops, expectRevision);
      if (ops.length) options.onApplied?.(library);
      if (peer && offer) {
        const state = await readOffers(backend);
        const before = state.peers[peer];
        const items = offer.filter((item) => !library.items[item.id]);
        const requested = (before?.requested ?? []).filter((id) => !library.items[id] && items.some((item) => item.id === id));
        await backend.writeLocalState(SYNC_OFFERS_KEY, { peers: { ...state.peers, [peer]: { items, requested, at: new Date().toISOString() } } } satisfies OfferState);
      }
      const scope = viewOf(library, peer, have, keeps);
      const view = scope ? scopeLibrary(library, scope) : library;
      const compared = compare ? scopeLibrary(view, new Set(compare.filter((id) => view.items[id]))) : view;
      return { revision: library.revision, hash: stateDigest(compared).hash };
    },
    async allows({ hash, peer }) {
      if (!options.scope || !peer) return true;
      const library = await backend.getLibrary();
      const scope = viewOf(library, peer, had.get(peer));
      const items = scope ? [...scope].map((id) => library.items[id]!) : Object.values(library.items);
      return items.some((item) => item.cover?.hash === hash || item.files.some((file) => file.hash === hash));
    },
  };
}
