import { correction, itemExtras, positionKey, same, stableJson, tagKey, valueOf, type Side, type Target } from './merge';
import type { Operation } from './operations';
import type { Device, Item, ItemId, Library } from './types';

/**
 * The check after a merge (M6 sync): both sides hash their library state, and where the hashes
 * differ, the parts that differ are copied from the source of truth. This keeps a bug in the merge
 * from leaving two instances apart without anyone noticing.
 *
 * The state is split into parts, one per item (with every user's rating, review and position for
 * it) and one per device, each hashed separately so the parts that differ can be found. A part
 * holds what operations set, and leaves out what's local to an instance or to when an operation
 * was applied: `origin` and `revision`, `updatedAt` stamps, a device's `lastSyncedAt`, and the
 * order of tags, files and a device's items (each side appends in the order it applied things).
 * What's fixed when an item or device is created (`addedAt`, a device's type) is left out too:
 * it travels with it, and no operation could set it.
 */

/** A library's state hash, and the hash of each part by key (`item:<id>`, `device:<id>`, `category:<id>`). */
export interface StateDigest {
  hash: string;
  parts: Record<string, string>;
}

export interface RepairPlan {
  /** The parts that differed and were repaired. */
  parts: string[];
  /** Operations to apply to the library being repaired. */
  operations: Operation[];
}

const ITEM_FIELDS = ['kind', 'title', 'creators', 'identifiers', 'cover'] as const;

/** A part's content, as compared and hashed. */
function itemPart(library: Library, item: Item) {
  const users: Record<string, unknown> = {};
  for (const [userId, data] of Object.entries(library.userData)) {
    const rating = data.ratings[item.id];
    const review = data.reviews[item.id]?.text;
    const position = positionKey(data.positions?.[item.id]);
    if (rating !== undefined || review !== undefined || position) users[userId] = { rating, review, position };
  }
  return {
    ...Object.fromEntries(ITEM_FIELDS.map((field) => [field, item[field]])),
    metadata: item.metadata,
    tags: [...item.tags].sort((a, b) => compare(tagKey(a), tagKey(b))),
    files: [...item.files].sort((a, b) => compare(a.hash, b.hash)),
    users,
  };
}

function devicePart(device: Device) {
  return { name: device.name, query: device.query, settings: device.settings, items: [...device.items].sort(), placed: device.placed };
}

const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** Hashes a library's state; libraries that agree have the same hash however each got there. */
export function stateDigest(library: Library): StateDigest {
  const parts: Record<string, string> = {};
  for (const item of Object.values(library.items)) parts[`item:${item.id}`] = hash64(stableJson(itemPart(library, item)));
  for (const device of Object.values(library.devices ?? {})) parts[`device:${device.id}`] = hash64(stableJson(devicePart(device)));
  for (const category of Object.values(library.categories ?? {})) parts[`category:${category.id}`] = hash64(stableJson(category));
  const lines = Object.keys(parts)
    .sort(compare)
    .map((key) => `${key}=${parts[key]}`);
  return { hash: hash64(lines.join('\n')), parts };
}

/** The keys of the parts that differ between two digests, including parts only one has. */
export function differingParts(a: StateDigest, b: StateDigest): string[] {
  const keys = new Set([...Object.keys(a.parts), ...Object.keys(b.parts)]);
  return [...keys].filter((key) => a.parts[key] !== b.parts[key]).sort(compare);
}

/**
 * The operations that make `dest` agree with `source` (the source of truth) on the parts that
 * differ, or just on `parts` when given. Items and devices missing on either side are added or
 * removed whole; the rest is corrected one target at a time, as the merge does.
 */
export function planRepair(source: Library, dest: Library, parts?: string[]): RepairPlan {
  parts ??= differingParts(stateDigest(source), stateDigest(dest));
  const repaired = new Set(parts);
  const has = (library: Library, kind: 'item' | 'device', id: string) =>
    kind === 'item' ? !!library.items[id] : !!library.devices?.[id];
  // Repaired parts end up as the source has them; the rest stay as they are (and should already agree).
  const existsAfter = (_side: Side, kind: 'item' | 'device', id: string) =>
    has(repaired.has(`${kind}:${id}`) ? source : dest, kind, id);

  /** Items and devices added or removed whole, whose parts need nothing more. */
  const whole = new Set<string>();
  const add = { items: [] as Item[], devices: [] as Device[] };
  const remove = { items: [] as ItemId[], devices: [] as string[] };
  const corrections: Operation[] = [];
  const fix = (target: Target, compareAs?: (value: unknown) => unknown) => {
    const a = valueOf(source, target);
    const b = valueOf(dest, target);
    if (compareAs ? same(compareAs(a), compareAs(b)) : same(a, b)) return;
    corrections.push(...correction(target, source, dest, 'theirs', existsAfter, whole));
  };

  for (const part of parts) {
    if (part.startsWith('category:')) {
      fix(['category', part.slice('category:'.length), 'definition']);
      continue;
    }
    const kind = part.slice(0, part.indexOf(':')) as 'item' | 'device';
    const id = part.slice(kind.length + 1);
    const inSource = has(source, kind, id);
    const inDest = has(dest, kind, id);
    if (inSource !== inDest) {
      whole.add(part);
      if (kind === 'item') {
        if (inSource) add.items.push(source.items[id]!);
        else remove.items.push(id);
      } else if (inSource) add.devices.push(source.devices![id]!);
      else remove.devices.push(id);
      continue;
    }
    if (!inSource) continue;
    if (kind === 'item') {
      const [a, b] = [source.items[id]!, dest.items[id]!];
      for (const field of ITEM_FIELDS) fix(['item', id, field]);
      for (const key of new Set([...Object.keys(a.metadata), ...Object.keys(b.metadata)])) fix(['item', id, 'metadata', key]);
      for (const tag of new Set([...a.tags, ...b.tags].map(tagKey))) fix(['item', id, 'tag', tag]);
      for (const hash of new Set([...a.files, ...b.files].map((f) => f.hash))) fix(['item', id, 'file', hash]);
      for (const userId of new Set([...Object.keys(source.userData), ...Object.keys(dest.userData)])) {
        fix(['rating', userId, id]);
        fix(['review', userId, id]);
        fix(['position', userId, id], positionKey as (value: unknown) => unknown);
      }
    } else {
      const [a, b] = [source.devices![id]!, dest.devices![id]!];
      fix(['device', id, 'name']);
      fix(['device', id, 'query']);
      for (const key of new Set([...Object.keys(a.settings), ...Object.keys(b.settings)])) fix(['device', id, 'setting', key]);
      for (const itemId of new Set([...a.items, ...b.items])) fix(['device', id, 'item', itemId]);
      for (const path of new Set([...Object.keys(a.placed), ...Object.keys(b.placed)])) fix(['device', id, 'placed', path]);
    }
  }

  // In the merge's order: whole additions, their parts and the corrections, then removals.
  const operations: Operation[] = [];
  for (const device of add.devices) operations.push({ type: 'addDevice', device: { ...device, items: [] } });
  for (const item of add.items) operations.push({ type: 'addItem', item }, ...itemExtras(source, item.id, 'theirs', existsAfter, whole));
  for (const device of add.devices) {
    const itemIds = device.items.filter((itemId) => existsAfter('theirs', 'item', itemId));
    if (itemIds.length) operations.push({ type: 'addDeviceItems', id: device.id, itemIds });
  }
  operations.push(...corrections);
  for (const id of remove.items) operations.push({ type: 'removeItem', id });
  for (const id of remove.devices) operations.push({ type: 'removeDevice', id });
  return { parts, operations };
}

/**
 * A 64-bit hash of a string, as 16 hex digits (cyrb53's mixing, keeping both 32-bit halves).
 * Not cryptographic: it only has to tell apart states that differ, and it's synchronous and fast.
 */
function hash64(text: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  const hex = (n: number) => (n >>> 0).toString(16).padStart(8, '0');
  return hex(h2) + hex(h1);
}
