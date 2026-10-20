import type { Operation } from './operations';
import type { Category, CategoryId, Device, DeviceId, Item, ItemId, Library, PlacedFile, ReadingPosition, UserId } from './types';

/**
 * Merging two instances of one library (M6 sync), as a pure function.
 *
 * Each side says what it changed since the two last agreed (its operations since the sync base),
 * and the merge works on *targets*: the separate things an operation writes, such as one field of
 * an item, one tag, one file, one user's rating, or one device setting. For each target either
 * side changed:
 * - if both now hold the same value, there's nothing to do;
 * - if one side changed it, the other side is given that value;
 * - if both changed it to different values, that's a conflict, and the source of truth's value
 *   wins on both sides. Reading positions are the exception: the newer one wins.
 *
 * So additive changes (new items, tags, files, a rating where there was none) go both ways, and
 * only real disagreements are decided by the source of truth. Items and devices are targets too:
 * one that's new on one side, or removed on one side and edited on the other, is transferred
 * whole (with its ratings, reviews, positions and device memberships) or removed.
 *
 * The result is plain operations for each side to apply, made from the current state rather than
 * replayed from the other side's log, so applying them to libraries that already agree is a no-op.
 */

export type Side = 'ours' | 'theirs';

export interface MergeSide {
  library: Library;
  /** The operations this side applied since the sync base, oldest first. */
  changes: Operation[];
}

/** What a target is, for showing a conflict: e.g. `['item', id, 'title']`, `['item', id, 'tag', 'fantasy']`. */
export type Target =
  | ['item', ItemId]
  | ['item', ItemId, 'kind' | 'title' | 'creators' | 'identifiers' | 'cover']
  | ['item', ItemId, 'metadata', string]
  | ['item', ItemId, 'tag', string]
  | ['item', ItemId, 'file', string]
  | ['rating' | 'review' | 'position', UserId, ItemId]
  | ['device', DeviceId]
  | ['device', DeviceId, 'name' | 'query']
  | ['device', DeviceId, 'setting', string]
  | ['device', DeviceId, 'item', ItemId]
  | ['device', DeviceId, 'files', ItemId]
  | ['device', DeviceId, 'excluded', ItemId]
  | ['device', DeviceId, 'placed', string]
  /** A browse category, compared whole. */
  | ['category', CategoryId, 'definition'];

export interface Conflict {
  target: Target;
  ours: unknown;
  theirs: unknown;
  winner: Side;
}

export interface MergePlan {
  /** Operations to apply to our library. */
  ours: Operation[];
  /** Operations to apply to theirs. */
  theirs: Operation[];
  conflicts: Conflict[];
}

export const tagKey = (tag: string) => tag.trim().toLowerCase();

/** The targets an operation writes. */
export function operationTargets(op: Operation): Target[] {
  switch (op.type) {
    case 'addItem':
      return [['item', op.item.id]];
    case 'removeItem':
      return [['item', op.id]];
    case 'updateItem':
      return (Object.keys(op.patch) as (keyof typeof op.patch)[]).map((field) => ['item', op.id, field]);
    case 'setMetadata':
      return [['item', op.id, 'metadata', op.key]];
    case 'addTags':
    case 'removeTags':
      return op.tags.map((tag) => ['item', op.id, 'tag', tagKey(tag)]);
    case 'attachFile':
      return [['item', op.id, 'file', op.file.hash]];
    case 'detachFile':
    case 'setFileMetadataKey':
      return [['item', op.id, 'file', op.hash]];
    case 'setRating':
      return [['rating', op.userId, op.itemId]];
    case 'setReview':
      return [['review', op.userId, op.itemId]];
    case 'setPosition':
      return [['position', op.userId, op.itemId]];
    case 'addDevice':
      return [['device', op.device.id]];
    case 'removeDevice':
      return [['device', op.id]];
    case 'updateDevice': {
      const targets: Target[] = [];
      if (op.patch.name !== undefined) targets.push(['device', op.id, 'name']);
      if (op.patch.query !== undefined) targets.push(['device', op.id, 'query']);
      for (const key of Object.keys(op.patch.settings ?? {})) targets.push(['device', op.id, 'setting', key]);
      return targets;
    }
    case 'addDeviceItems':
      return op.itemIds.map((itemId) => ['device', op.id, 'item', itemId]);
    case 'removeDeviceItems':
      // Taking an item out takes its particular files with it.
      return op.itemIds.flatMap((itemId): Target[] => [
        ['device', op.id, 'item', itemId],
        ['device', op.id, 'files', itemId],
      ]);
    case 'excludeDeviceItems':
    case 'unexcludeDeviceItems':
      return op.itemIds.map((itemId) => ['device', op.id, 'excluded', itemId]);
    case 'setDeviceFiles':
      return [['device', op.id, 'files', op.itemId], ...(op.hashes?.length ? [['device', op.id, 'item', op.itemId] as Target] : [])];
    case 'recordDeviceSync':
      return [...Object.keys(op.placed), ...op.removed].map((path) => ['device', op.id, 'placed', path]);
    case 'setCategory':
      return [['category', op.category.id, 'definition']];
    case 'removeCategory':
      return [['category', op.id, 'definition']];
  }
}

/** A target's value in a library: undefined when absent (an item, tag, rating or setting that isn't there). */
export function valueOf(library: Library, target: Target): unknown {
  if (target[0] === 'item') {
    const item = library.items[target[1]];
    if (target.length === 2 || !item) return target.length === 2 ? !!item : undefined;
    switch (target[2]) {
      case 'metadata':
        return item.metadata[target[3]];
      case 'tag':
        // Tags are unique ignoring case, so this is the one tag "Classic" or "classic", spelled as here.
        return item.tags.find((t) => tagKey(t) === target[3]);
      case 'file':
        return item.files.find((f) => f.hash === target[3]);
      default:
        return item[target[2]];
    }
  }
  if (target[0] === 'device') {
    const device = library.devices?.[target[1]];
    if (target.length === 2 || !device) return target.length === 2 ? !!device : undefined;
    switch (target[2]) {
      case 'setting':
        return device.settings[target[3]];
      case 'item':
        return device.items.includes(target[3]);
      case 'files': {
        const files = device.files?.[target[3]];
        return files && [...files].sort();
      }
      case 'excluded':
        return !!device.excluded?.includes(target[3]);
      case 'placed':
        return device.placed[target[3]];
      default:
        return device[target[2]];
    }
  }
  if (target[0] === 'category') return library.categories?.[target[1]];
  const data = library.userData[target[1]];
  if (target[0] === 'rating') return data?.ratings[target[2]];
  if (target[0] === 'review') return data?.reviews[target[2]]?.text;
  return data?.positions?.[target[2]];
}

/** Compares values as stored, ignoring object key order. */
export function same(a: unknown, b: unknown): boolean {
  return stableJson(a) === stableJson(b);
}

export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value).filter(([, v]) => v !== undefined);
    entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'undefined';
}

export const positionKey = (p: ReadingPosition | undefined) =>
  p && { hash: p.hash, locator: p.locator, progress: p.progress, ...(p.setAside && { setAside: true }) };

const targetKey = (target: Target) => JSON.stringify(target);

/** Plans the operations that bring two instances into agreement. */
export function planMerge(ours: MergeSide, theirs: MergeSide, truth: Side): MergePlan {
  const sides = { ours, theirs };
  const changed = { ours: new Map<string, Target>(), theirs: new Map<string, Target>() };
  for (const side of ['ours', 'theirs'] as const) {
    for (const op of sides[side].changes) for (const target of operationTargets(op)) changed[side].set(targetKey(target), target);
  }
  // Whole items and devices one side added or removed: an edit on the other side to anything in them
  // is a change to the same thing.
  const touched = { ours: new Set<string>(), theirs: new Set<string>() };
  for (const side of ['ours', 'theirs'] as const) {
    for (const t of changed[side].values()) {
      if (t[0] === 'category') continue;
      touched[side].add(t[0] === 'item' || t[0] === 'device' ? `${t[0]}:${t[1]}` : `item:${t[2]}`);
    }
  }
  const touchedWhole = (side: Side, kind: 'item' | 'device', id: string) => touched[side].has(`${kind}:${id}`);

  const plan: MergePlan = { ours: [], theirs: [], conflicts: [] };
  const other = (side: Side): Side => (side === 'ours' ? 'theirs' : 'ours');
  /** Who wins each target both sides changed differently, and the conflicts to report. */
  const decide = (target: Target, oursValue: unknown, theirsValue: unknown): Side => {
    if (target[0] === 'position') {
      const a = (oursValue as ReadingPosition | undefined)?.updatedAt ?? '';
      const b = (theirsValue as ReadingPosition | undefined)?.updatedAt ?? '';
      return a === b ? truth : a > b ? 'ours' : 'theirs';
    }
    plan.conflicts.push({ target, ours: oursValue, theirs: theirsValue, winner: truth });
    return truth;
  };

  // 1. Whole items and devices: which exist on both sides afterwards, and which a side must add or remove.
  const restore = { ours: [] as Item[], theirs: [] as Item[] };
  const remove = { ours: [] as ItemId[], theirs: [] as ItemId[] };
  const restoreDevices = { ours: [] as Device[], theirs: [] as Device[] };
  const removeDevices = { ours: [] as DeviceId[], theirs: [] as DeviceId[] };
  /** Items and devices handled whole on a side, whose parts need no further operations there. */
  const wholeOn = { ours: new Set<string>(), theirs: new Set<string>() };

  const wholeTargets = new Map<string, Target>();
  for (const side of ['ours', 'theirs'] as const) {
    for (const [key, target] of changed[side]) if (target.length === 2) wholeTargets.set(key, target);
  }
  for (const target of wholeTargets.values()) {
    const [kind, id] = target as ['item' | 'device', string];
    const exists = { ours: valueOf(ours.library, target) as boolean, theirs: valueOf(theirs.library, target) as boolean };
    if (exists.ours === exists.theirs) continue;
    // A side that added or removed it, against the other side's edits to it (or its own add/remove).
    const by = (side: Side) => changed[side].has(targetKey(target)) || touchedWhole(side, kind, id);
    let source: Side;
    if (by('ours') && by('theirs')) source = decide(target, exists.ours, exists.theirs);
    else source = changed.ours.has(targetKey(target)) ? 'ours' : 'theirs';
    const to = other(source);
    wholeOn[to].add(`${kind}:${id}`);
    if (kind === 'item') {
      if (exists[source]) restore[to].push(sides[source].library.items[id]!);
      else remove[to].push(id);
    } else if (exists[source]) restoreDevices[to].push(sides[source].library.devices![id]!);
    else removeDevices[to].push(id);
  }

  /** Whether an item or device exists on a side once the merge is applied. */
  const existsAfter = (side: Side, kind: 'item' | 'device', id: string): boolean => {
    if (kind === 'item') {
      if (remove[side].includes(id)) return false;
      return !!sides[side].library.items[id] || restore[side].some((i) => i.id === id);
    }
    if (removeDevices[side].includes(id)) return false;
    return !!sides[side].library.devices?.[id] || restoreDevices[side].some((d) => d.id === id);
  };

  // 2. Everything else, target by target.
  const corrections = { ours: [] as Operation[], theirs: [] as Operation[] };
  const parts = new Map<string, Target>([...changed.ours, ...changed.theirs]);
  for (const [key, target] of parts) {
    if (target.length === 2) continue;
    const oursValue = valueOf(ours.library, target);
    const theirsValue = valueOf(theirs.library, target);
    const equal =
      target[0] === 'position'
        ? same(positionKey(oursValue as ReadingPosition), positionKey(theirsValue as ReadingPosition))
        : same(oursValue, theirsValue);
    if (equal) continue;
    const source: Side =
      changed.ours.has(key) && changed.theirs.has(key)
        ? decide(target, oursValue, theirsValue)
        : changed.ours.has(key)
          ? 'ours'
          : 'theirs';
    const to = other(source);
    corrections[to].push(...correction(target, sides[source].library, sides[to].library, to, existsAfter, wholeOn[to]));
  }

  // 3. In order: whole additions, then their parts and the rest, then removals (which take their parts with them).
  for (const side of ['ours', 'theirs'] as const) {
    const source = sides[other(side)].library;
    for (const device of restoreDevices[side]) plan[side].push({ type: 'addDevice', device: emptyDevice(device) });
    for (const item of restore[side]) {
      plan[side].push({ type: 'addItem', item }, ...itemExtras(source, item.id, side, existsAfter, wholeOn[side]));
    }
    for (const device of restoreDevices[side]) plan[side].push(...deviceCatalog(device, (id) => existsAfter(side, 'item', id)));
    plan[side].push(...corrections[side]);
    for (const id of remove[side]) plan[side].push({ type: 'removeItem', id });
    for (const id of removeDevices[side]) plan[side].push({ type: 'removeDevice', id });
  }
  return plan;
}

/** The operations that give a target, on side `to` (library `dest`), the value it has in `source`. */
export function correction(
  target: Target,
  source: Library,
  dest: Library,
  to: Side,
  existsAfter: (side: Side, kind: 'item' | 'device', id: string) => boolean,
  whole: Set<string>,
): Operation[] {
  const op = correctionOp(target, source, to, existsAfter, whole);
  // A tag spelled differently on each side ("classic", "Classic") is respelled: adding it alone would do nothing.
  if (op?.type === 'addTags' && target[0] === 'item' && valueOf(dest, target) !== undefined) {
    return [{ type: 'removeTags', id: op.id, tags: op.tags }, op];
  }
  // Likewise a file with the same hash but different details (its name, say): attaching it again does nothing.
  if (op?.type === 'attachFile' && valueOf(dest, target) !== undefined) {
    return [{ type: 'detachFile', id: op.id, hash: op.file.hash }, op];
  }
  return op ? [op] : [];
}

function correctionOp(
  target: Target,
  source: Library,
  to: Side,
  existsAfter: (side: Side, kind: 'item' | 'device', id: string) => boolean,
  whole: Set<string>,
): Operation | undefined {
  const value = valueOf(source, target);
  // Parts of an item or device the source doesn't have: whether it exists at all was settled whole.
  if (target[0] === 'item') {
    const id = target[1];
    if (whole.has(`item:${id}`) || !existsAfter(to, 'item', id) || !source.items[id]) return undefined;
    switch (target[2]) {
      case 'metadata':
        return { type: 'setMetadata', id, key: target[3]!, value: value as Item['metadata'][string] | undefined };
      case 'tag':
        return value === undefined
          ? { type: 'removeTags', id, tags: [target[3]!] }
          : { type: 'addTags', id, tags: [value as string] };
      case 'file':
        return value === undefined
          ? { type: 'detachFile', id, hash: target[3]! }
          : { type: 'attachFile', id, file: value as Item['files'][number] };
      default:
        // Only `cover` can be undefined here; a logged patch drops it, but the libraries agree by then.
        return { type: 'updateItem', id, patch: { [target[2]!]: value } };
    }
  }
  if (target[0] === 'device') {
    const id = target[1];
    if (whole.has(`device:${id}`) || !existsAfter(to, 'device', id) || !source.devices?.[id]) return undefined;
    switch (target[2]) {
      case 'setting':
        return { type: 'updateDevice', id, patch: { settings: { [target[3]!]: value as Device['settings'][string] } } };
      case 'item':
        // An item transferred whole brings its device memberships with it, and one the source removed took them away.
        if (!existsAfter(to, 'item', target[3]!) || whole.has(`item:${target[3]}`) || !source.items[target[3]!]) return undefined;
        return value
          ? { type: 'addDeviceItems', id, itemIds: [target[3]!] }
          : { type: 'removeDeviceItems', id, itemIds: [target[3]!] };
      case 'files':
        if (!existsAfter(to, 'item', target[3]!) || whole.has(`item:${target[3]}`) || !source.items[target[3]!]) return undefined;
        return { type: 'setDeviceFiles', id, itemId: target[3]!, hashes: value as string[] | undefined };
      case 'excluded':
        // Kept off whether or not the item exists anywhere.
        return { type: value ? 'excludeDeviceItems' : 'unexcludeDeviceItems', id, itemIds: [target[3]!] };
      case 'placed':
        return value
          ? { type: 'recordDeviceSync', id, placed: { [target[3]!]: value as PlacedFile }, removed: [] }
          : { type: 'recordDeviceSync', id, placed: {}, removed: [target[3]!] };
      case 'name':
        return { type: 'updateDevice', id, patch: { name: value as string } };
      default:
        return { type: 'updateDevice', id, patch: { query: (value as string | undefined) ?? '' } };
    }
  }
  if (target[0] === 'category') {
    return value ? { type: 'setCategory', category: value as Category } : { type: 'removeCategory', id: target[1] };
  }
  const [kind, userId, itemId] = target;
  if (whole.has(`item:${itemId}`) || !existsAfter(to, 'item', itemId) || !source.items[itemId]) return undefined;
  return userOp(kind, userId, itemId, source);
}

function userOp(kind: 'rating' | 'review' | 'position', userId: UserId, itemId: ItemId, source: Library): Operation {
  const data = source.userData[userId];
  if (kind === 'rating') return { type: 'setRating', userId, itemId, rating: data?.ratings[itemId] };
  if (kind === 'review') return { type: 'setReview', userId, itemId, text: data?.reviews[itemId]?.text };
  const position = data?.positions?.[itemId];
  return {
    type: 'setPosition',
    userId,
    itemId,
    position: position && {
      hash: position.hash,
      locator: position.locator,
      progress: position.progress,
      ...(position.setAside && { setAside: true }),
    },
  };
}

/** A device added whole, before its items exist: its catalog is added once they do (`deviceCatalog`). */
export function emptyDevice(device: Device): Device {
  const { files: _files, ...rest } = device;
  return { ...rest, items: [] };
}

/** The operations giving a device added whole (`emptyDevice`) its catalog, for the items that exist. */
export function deviceCatalog(device: Device, exists: (itemId: ItemId) => boolean): Operation[] {
  const itemIds = device.items.filter(exists);
  if (!itemIds.length) return [];
  const files = Object.entries(device.files ?? {}).filter(([itemId]) => itemIds.includes(itemId));
  return [
    { type: 'addDeviceItems', id: device.id, itemIds },
    ...files.map(([itemId, hashes]): Operation => ({ type: 'setDeviceFiles', id: device.id, itemId, hashes })),
  ];
}

/** What goes with an item transferred whole: its ratings, reviews and positions, and the devices it's on. */
export function itemExtras(
  source: Library,
  itemId: ItemId,
  to: Side,
  existsAfter: (side: Side, kind: 'item' | 'device', id: string) => boolean,
  whole: Set<string>,
): Operation[] {
  const ops: Operation[] = [];
  for (const [userId, data] of Object.entries(source.userData)) {
    if (data.ratings[itemId] !== undefined) ops.push(userOp('rating', userId, itemId, source));
    if (data.reviews[itemId] !== undefined) ops.push(userOp('review', userId, itemId, source));
    if (data.positions?.[itemId] !== undefined) ops.push(userOp('position', userId, itemId, source));
  }
  for (const device of Object.values(source.devices ?? {})) {
    // Devices transferred whole get their items once the items exist.
    if (device.items.includes(itemId) && existsAfter(to, 'device', device.id) && !whole.has(`device:${device.id}`)) {
      ops.push({ type: 'addDeviceItems', id: device.id, itemIds: [itemId] });
      const files = device.files?.[itemId];
      if (files) ops.push({ type: 'setDeviceFiles', id: device.id, itemId, hashes: files });
    }
  }
  return ops;
}
