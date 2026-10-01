import {
  LOCAL_USER,
  SCHEMA_VERSION,
  type Creator,
  type FileHash,
  type FileRef,
  type Item,
  type ItemId,
  type ItemKind,
  type Library,
  type MetadataValue,
  type UserData,
  type UserId,
} from './types';

/** Top-level item fields that are replaced wholesale by `updateItem`. */
export type ItemPatch = Partial<Pick<Item, 'kind' | 'title' | 'creators' | 'identifiers' | 'cover'>>;

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
  | { type: 'setReview'; userId: UserId; itemId: ItemId; text: string | undefined };

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
          return [userId, { ratings, reviews }];
        }),
      );
      return { ...next, items, userData };
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
