import {
  LOCAL_USER,
  SCHEMA_VERSION,
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
  | { type: 'setRating'; userId: UserId; itemId: ItemId; rating: number | undefined }
  | { type: 'setReview'; userId: UserId; itemId: ItemId; text: string | undefined }
  | { type: 'setPosition'; userId: UserId; itemId: ItemId; position: Omit<ReadingPosition, 'updatedAt'> | undefined }
  | { type: 'addDevice'; device: Device }
  | { type: 'updateDevice'; id: DeviceId; patch: DevicePatch }
  | { type: 'removeDevice'; id: DeviceId }
  | { type: 'addDeviceItems'; id: DeviceId; itemIds: ItemId[] }
  | { type: 'removeDeviceItems'; id: DeviceId; itemIds: ItemId[] }
  /** What a sync did: files it put on the device, by path, and paths it removed or found gone. */
  | { type: 'recordDeviceSync'; id: DeviceId; placed: Record<string, PlacedFile>; removed: string[] };

export interface Change {
  revision: number;
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
  return { schemaVersion: SCHEMA_VERSION, id, name, revision: 0, items: {}, userData: {} };
}

export interface NewItem {
  title: string;
  kind?: ItemKind;
  creators?: Creator[];
  identifiers?: Record<string, string>;
  tags?: string[];
  metadata?: Record<string, MetadataValue>;
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
    metadata: fields.metadata ?? {},
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
      if (op.value === undefined) delete metadata[op.key];
      else metadata[op.key] = op.value;
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
      // Taken off devices too; what's already on them is removed by their next sync.
      const devices = library.devices && mapValues(library.devices, (d) => ({ ...d, items: d.items.filter((id) => id !== op.id) }));
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
      return withDevice({ ...device, items: device.items.filter((id) => !removed.has(id)) });
    }
    case 'recordDeviceSync': {
      const device = requireDevice(op.id);
      const placed = { ...device.placed };
      for (const path of op.removed) delete placed[path];
      Object.assign(placed, op.placed);
      return withDevice({ ...device, placed, lastSyncedAt: at });
    }
  }
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
    changes.push({ revision: library.revision, at, op });
  }
  return { library, changes };
}

export function userData(library: Library, userId: UserId = LOCAL_USER): UserData {
  return library.userData[userId] ?? { ratings: {}, reviews: {} };
}

function mapValues<T>(record: Record<string, T>, f: (value: T) => T): Record<string, T> {
  return Object.fromEntries(Object.entries(record).map(([key, value]) => [key, f(value)]));
}
