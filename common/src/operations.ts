import {
  LOCAL_USER,
  SCHEMA_VERSION,
  type Category,
  type CategoryId,
  type Creator,
  type Device,
  type DeviceId,
  type FileHash,
  type FileRef,
  type Item,
  type ItemId,
  type ItemKind,
  type Library,
  type MetadataValue,
  type PlacedFile,
  type ReadingPosition,
  type UserData,
  type UserId,
} from './types';
import { normalizeMetadata, normalizeValue } from './metadata';

/** Top-level item fields that are replaced wholesale by `updateItem`. */
export type ItemPatch = Partial<Pick<Item, 'kind' | 'title' | 'creators' | 'identifiers' | 'cover'>>;

/** A device's name, and settings by key (undefined removes one), so edits on different instances merge. */
export interface DevicePatch {
  name?: string;
  /** An empty string clears it. */
  query?: string;
  settings?: Record<string, MetadataValue | undefined>;
}

/**
 * Every mutation of a library is one of these. They are recorded in the change
 * log, so they must stay JSON-serializable and backwards compatible.
 *
 * Custom metadata is set one key at a time, and tags are added and removed
 * individually (rather than replaced via `updateItem`), so concurrent edits on
 * different instances can merge when syncing.
 */
export type Operation =
  | { type: 'addItem'; item: Item }
  | { type: 'updateItem'; id: ItemId; patch: ItemPatch }
  | { type: 'setMetadata'; id: ItemId; key: string; value: MetadataValue | undefined }
  | { type: 'addTags'; id: ItemId; tags: string[] }
  | { type: 'removeTags'; id: ItemId; tags: string[] }
  | { type: 'removeItem'; id: ItemId }
  | { type: 'attachFile'; id: ItemId; file: FileRef }
  | { type: 'detachFile'; id: ItemId; hash: FileHash }
  /** Records the fingerprint of the metadata written into one of an item's files (`FileRef.metadataKey`), or that it's unknown. */
  | { type: 'setFileMetadataKey'; id: ItemId; hash: FileHash; metadataKey: string | undefined }
  | { type: 'setRating'; userId: UserId; itemId: ItemId; rating: number | undefined }
  | { type: 'setReview'; userId: UserId; itemId: ItemId; text: string | undefined }
  | { type: 'setPosition'; userId: UserId; itemId: ItemId; position: Omit<ReadingPosition, 'updatedAt'> | undefined }
  | { type: 'addDevice'; device: Device }
  | { type: 'updateDevice'; id: DeviceId; patch: DevicePatch }
  | { type: 'removeDevice'; id: DeviceId }
  | { type: 'addDeviceItems'; id: DeviceId; itemIds: ItemId[] }
  /** Takes items out of a device's catalog, with any particular files of theirs it held. */
  | { type: 'removeDeviceItems'; id: DeviceId; itemIds: ItemId[] }
  /** Holds only these files of an item in a device's catalog (`Device.files`), adding it if need be, or the item as a whole when undefined. */
  | { type: 'setDeviceFiles'; id: DeviceId; itemId: ItemId; hashes: FileHash[] | undefined }
  /** Keeps items off a device whether or not they're chosen or match its search (`Device.excluded`), or stops keeping them off. */
  | { type: 'excludeDeviceItems'; id: DeviceId; itemIds: ItemId[] }
  | { type: 'unexcludeDeviceItems'; id: DeviceId; itemIds: ItemId[] }
  /** What a sync did: files it put on the device, by path, and paths it removed or found gone. */
  | { type: 'recordDeviceSync'; id: DeviceId; placed: Record<string, PlacedFile>; removed: string[] }
  /** Adds a browse category, or replaces it whole. */
  | { type: 'setCategory'; category: Category }
  | { type: 'removeCategory'; id: CategoryId };

export interface Change {
  /** This instance's revision once the change was applied. */
  revision: number;
  /**
   * The change's ID across instances: the instance it was made on and that instance's revision then.
   * Unique, and increasing per origin (with gaps, where changes from elsewhere were applied between).
   */
  origin: string;
  seq: number;
  /** ISO timestamp of when the operation was applied. */
  at: string;
  op: Operation;
}

export class OperationError extends Error {
  constructor(
    message: string,
    readonly op: Operation,
  ) {
    super(message);
    this.name = 'OperationError';
  }
}

export function createLibrary(name: string, id: string = crypto.randomUUID()): Library {
  return { schemaVersion: SCHEMA_VERSION, id, name, revision: 0, origin: crypto.randomUUID(), items: {}, userData: {} };
}

export interface NewItem {
  title: string;
  kind?: ItemKind;
  creators?: Creator[];
  identifiers?: Record<string, string>;
  tags?: string[];
  metadata?: Record<string, MetadataValue | undefined>;
  files?: FileRef[];
  cover?: Item['cover'];
}

export function createItem(fields: NewItem, now: string = new Date().toISOString()): Item {
  return {
    id: crypto.randomUUID(),
    kind: fields.kind ?? 'book',
    title: fields.title,
    creators: fields.creators ?? [],
    identifiers: fields.identifiers ?? {},
    tags: mergeTags([], fields.tags ?? []),
    metadata: normalizeMetadata(fields.metadata ?? {}),
    files: fields.files ?? [],
    ...(fields.cover && { cover: fields.cover }),
    addedAt: now,
    updatedAt: now,
  };
}

export function createDevice(
  fields: Pick<Device, 'name' | 'type'> & Partial<Pick<Device, 'settings' | 'query'>>,
  now: string = new Date().toISOString(),
): Device {
  const query = fields.query?.trim();
  return {
    id: crypto.randomUUID(),
    name: fields.name,
    type: fields.type,
    items: [],
    ...(query && { query }),
    settings: fields.settings ?? {},
    placed: {},
    addedAt: now,
  };
}

const tagKey = (tag: string) => tag.trim().toLowerCase();

/** Appends trimmed tags not already present, comparing case-insensitively. */
export function mergeTags(existing: string[], added: string[]): string[] {
  const seen = new Set(existing.map(tagKey));
  const merged = [...existing];
  for (const tag of added) {
    const trimmed = tag.trim();
    if (!trimmed || seen.has(tagKey(trimmed))) continue;
    seen.add(tagKey(trimmed));
    merged.push(trimmed);
  }
  return merged;
}

/** Pure: returns a new library with `op` applied, or throws `OperationError`. */
export function applyOperation(library: Library, op: Operation, at: string): Library {
  const next = { ...library, revision: library.revision + 1 };

  const requireItem = (id: ItemId): Item => {
    const item = library.items[id];
    if (!item) throw new OperationError(`No item with id ${id}`, op);
    return item;
  };
  const withItem = (item: Item): Library => ({
    ...next,
    items: { ...library.items, [item.id]: { ...item, updatedAt: at } },
  });
  const requireDevice = (id: DeviceId): Device => {
    const device = library.devices?.[id];
    if (!device) throw new OperationError(`No device with id ${id}`, op);
    return device;
  };
  const withDevice = (device: Device): Library => ({ ...next, devices: { ...library.devices, [device.id]: device } });
  const withUserData = (userId: UserId, update: (data: UserData) => UserData): Library => {
    const current = library.userData[userId] ?? { ratings: {}, reviews: {} };
    return { ...next, userData: { ...library.userData, [userId]: update(current) } };
  };

  switch (op.type) {
    case 'addItem': {
      if (library.items[op.item.id]) throw new OperationError(`Item ${op.item.id} already exists`, op);
      return { ...next, items: { ...library.items, [op.item.id]: op.item } };
    }
    case 'updateItem': {
      const item = requireItem(op.id);
      return withItem({ ...item, ...op.patch });
    }
    case 'setMetadata': {
      const item = requireItem(op.id);
      const metadata = { ...item.metadata };
      // Normalized as it's stored, e.g. "June 1990" as 1990-06; one that normalizes to nothing removes the key.
      const value = normalizeValue(op.key, op.value);
      if (value === undefined) delete metadata[op.key];
      else metadata[op.key] = value;
      return withItem({ ...item, metadata });
    }
    case 'addTags': {
      const item = requireItem(op.id);
      return withItem({ ...item, tags: mergeTags(item.tags, op.tags) });
    }
    case 'removeTags': {
      const item = requireItem(op.id);
      const removed = new Set(op.tags.map(tagKey));
      return withItem({ ...item, tags: item.tags.filter((t) => !removed.has(tagKey(t))) });
    }
    case 'removeItem': {
      requireItem(op.id);
      const { [op.id]: _removed, ...items } = library.items;
      const userData = Object.fromEntries(
        Object.entries(library.userData).map(([userId, data]) => {
          const { [op.id]: _rating, ...ratings } = data.ratings;
          const { [op.id]: _review, ...reviews } = data.reviews;
          if (!data.positions) return [userId, { ratings, reviews }];
          const { [op.id]: _position, ...positions } = data.positions;
          return [userId, { ratings, reviews, positions }];
        }),
      );
      // Taken out of devices' catalogs too; what's already on them stays.
      const devices = library.devices && mapValues(library.devices, (d) => withoutFiles({ ...d, items: d.items.filter((id) => id !== op.id) }, [op.id]));
      return { ...next, items, userData, ...(devices && { devices }) };
    }
    case 'attachFile': {
      const item = requireItem(op.id);
      if (item.files.some((f) => f.hash === op.file.hash)) return next;
      return withItem({ ...item, files: [...item.files, op.file] });
    }
    case 'detachFile': {
      const item = requireItem(op.id);
      return withItem({ ...item, files: item.files.filter((f) => f.hash !== op.hash) });
    }
    case 'setFileMetadataKey': {
      const item = requireItem(op.id);
      if (!item.files.some((f) => f.hash === op.hash)) throw new OperationError(`Item ${op.id} has no file ${op.hash}`, op);
      const files = item.files.map((f) => {
        if (f.hash !== op.hash) return f;
        const { metadataKey: _old, ...rest } = f;
        return op.metadataKey === undefined ? rest : { ...rest, metadataKey: op.metadataKey };
      });
      return withItem({ ...item, files });
    }
    case 'setRating': {
      requireItem(op.itemId);
      if (op.rating !== undefined && !(op.rating >= 0 && op.rating <= 5)) {
        throw new OperationError(`Rating must be between 0 and 5, got ${op.rating}`, op);
      }
      return withUserData(op.userId, (data) => {
        const { [op.itemId]: _old, ...ratings } = data.ratings;
        return { ...data, ratings: op.rating === undefined ? ratings : { ...ratings, [op.itemId]: op.rating } };
      });
    }
    case 'setReview': {
      requireItem(op.itemId);
      return withUserData(op.userId, (data) => {
        const { [op.itemId]: _old, ...reviews } = data.reviews;
        return {
          ...data,
          reviews: op.text === undefined ? reviews : { ...reviews, [op.itemId]: { text: op.text, updatedAt: at } },
        };
      });
    }
    case 'setPosition': {
      requireItem(op.itemId);
      const progress = op.position?.progress;
      if (progress !== undefined && !(progress >= 0 && progress <= 1)) {
        throw new OperationError(`Progress must be between 0 and 1, got ${progress}`, op);
      }
      return withUserData(op.userId, (data) => {
        const { [op.itemId]: _old, ...positions } = data.positions ?? {};
        return {
          ...data,
          positions:
            op.position === undefined ? positions : { ...positions, [op.itemId]: { ...op.position, updatedAt: at } },
        };
      });
    }
    case 'addDevice': {
      if (library.devices?.[op.device.id]) throw new OperationError(`Device ${op.device.id} already exists`, op);
      return withDevice(op.device);
    }
    case 'updateDevice': {
      const device = requireDevice(op.id);
      const settings = { ...device.settings };
      for (const [key, value] of Object.entries(op.patch.settings ?? {})) {
        if (value === undefined) delete settings[key];
        else settings[key] = value;
      }
      const { query: _query, ...rest } = device;
      const query = op.patch.query === undefined ? device.query : op.patch.query.trim() || undefined;
      return withDevice({ ...rest, ...(op.patch.name !== undefined && { name: op.patch.name }), settings, ...(query && { query }) });
    }
    case 'removeDevice': {
      requireDevice(op.id);
      const { [op.id]: _removed, ...devices } = library.devices ?? {};
      return { ...next, devices };
    }
    case 'addDeviceItems': {
      const device = requireDevice(op.id);
      op.itemIds.forEach(requireItem);
      const added = op.itemIds.filter((id, i) => !device.items.includes(id) && op.itemIds.indexOf(id) === i);
      return withDevice({ ...device, items: [...device.items, ...added] });
    }
    case 'removeDeviceItems': {
      const device = requireDevice(op.id);
      const removed = new Set(op.itemIds);
      return withDevice(withoutFiles({ ...device, items: device.items.filter((id) => !removed.has(id)) }, op.itemIds));
    }
    case 'setDeviceFiles': {
      const device = requireDevice(op.id);
      const rest = withoutFiles(device, [op.itemId]);
      const hashes = op.hashes && [...new Set(op.hashes)];
      if (!hashes?.length) return withDevice(rest);
      // Particular files put the item in the catalog, if it wasn't.
      requireItem(op.itemId);
      const items = rest.items.includes(op.itemId) ? rest.items : [...rest.items, op.itemId];
      return withDevice({ ...rest, items, files: { ...rest.files, [op.itemId]: hashes } });
    }
    case 'excludeDeviceItems': {
      // Items needn't exist here: a device can be kept from items this instance never had.
      const device = requireDevice(op.id);
      const excluded = device.excluded ?? [];
      const added = op.itemIds.filter((id, i) => !excluded.includes(id) && op.itemIds.indexOf(id) === i);
      return withDevice({ ...device, excluded: [...excluded, ...added] });
    }
    case 'unexcludeDeviceItems': {
      const device = requireDevice(op.id);
      const removed = new Set(op.itemIds);
      const excluded = (device.excluded ?? []).filter((id) => !removed.has(id));
      const { excluded: _, ...rest } = device;
      return withDevice(excluded.length ? { ...rest, excluded } : rest);
    }
    case 'recordDeviceSync': {
      const device = requireDevice(op.id);
      const placed = { ...device.placed };
      for (const path of op.removed) delete placed[path];
      Object.assign(placed, op.placed);
      return withDevice({ ...device, placed, lastSyncedAt: at });
    }
    case 'setCategory': {
      const name = op.category.name.trim();
      if (!name) throw new OperationError('A category needs a name', op);
      const entries = op.category.entries.map((e) => ({ label: e.label.trim(), query: e.query.trim() }));
      if (entries.some((e) => !e.query)) throw new OperationError('Each entry of a category needs a search', op);
      return { ...next, categories: { ...library.categories, [op.category.id]: { id: op.category.id, name, entries } } };
    }
    case 'removeCategory': {
      if (!library.categories?.[op.id]) throw new OperationError(`No category with id ${op.id}`, op);
      const { [op.id]: _removed, ...categories } = library.categories;
      return { ...next, categories };
    }
  }
}

export function createCategory(fields: Omit<Category, 'id'>): Category {
  return { id: crypto.randomUUID(), ...fields };
}

/** Applies operations in order, all or nothing. */
export function applyOperations(
  library: Library,
  ops: Operation[],
  at: string = new Date().toISOString(),
): { library: Library; changes: Change[] } {
  const changes: Change[] = [];
  for (const op of ops) {
    library = applyOperation(library, op, at);
    changes.push({ revision: library.revision, origin: library.origin, seq: library.revision, at, op });
  }
  return { library, changes };
}

export function userData(library: Library, userId: UserId = LOCAL_USER): UserData {
  return library.userData[userId] ?? { ratings: {}, reviews: {} };
}

/** A device without the particular files of these items (`Device.files`), dropping the record when it's empty. */
function withoutFiles(device: Device, itemIds: ItemId[]): Device {
  if (!device.files || !itemIds.some((id) => device.files![id])) return device;
  const files = { ...device.files };
  for (const id of itemIds) delete files[id];
  const { files: _files, ...rest } = device;
  return Object.keys(files).length ? { ...rest, files } : rest;
}

function mapValues<T>(record: Record<string, T>, f: (value: T) => T): Record<string, T> {
  return Object.fromEntries(Object.entries(record).map(([key, value]) => [key, f(value)]));
}
