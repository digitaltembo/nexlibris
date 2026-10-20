import type { Operation } from './operations';
import { normalizeMetadata, normalizeValue } from './metadata';
import { SCHEMA_VERSION, type Library, type MetadataValue } from './types';

/**
 * Schema migrations. When the stored shape of a library changes, bump `SCHEMA_VERSION` and add a
 * step here that takes a library at the old version to the new one, and logged operations too if
 * their shape changed (the change log is replayed after a crash, and M6 sync exchanges it).
 * Libraries are migrated when loaded and when restored from a backup; a library from a newer
 * version is refused rather than misread, and then overwritten.
 */
interface Migration {
  library(library: Record<string, unknown>): Record<string, unknown>;
  operation?(op: Record<string, unknown>): Record<string, unknown>;
}

/** `MIGRATIONS[n]` takes version n to n + 1. */
export const MIGRATIONS: Record<number, Migration> = {
  // An ID for this instance, recorded on its changes (`Library.origin`). Changes logged before it are this
  // instance's own; `StoredLibraryBackend` reads them as `{origin, seq: revision}` rather than rewriting the log.
  1: { library: (library) => ({ ...library, origin: crypto.randomUUID() }) },
  // Browse categories (`Library.categories`, and the setCategory and removeCategory operations). Nothing to change:
  // the version says an older nexlibris can't read them, and refuses the library rather than dropping them.
  2: { library: (library) => library },
  // Typed metadata (`BookMetadata`): dates as partial ISO dates, the series index and pages as numbers.
  3: {
    library: (library) => ({
      ...library,
      items: Object.fromEntries(
        Object.entries(library.items as Record<string, StoredItem>).map(([id, item]) => [id, { ...item, metadata: normalizeMetadata(item.metadata) }]),
      ),
    }),
    operation: (op) => {
      if (op.type === 'setMetadata') return { ...op, value: normalizeValue(op.key as string, op.value as MetadataValue | undefined) };
      if (op.type === 'addItem') {
        const item = op.item as StoredItem;
        return { ...op, item: { ...item, metadata: normalizeMetadata(item.metadata) } };
      }
      return op;
    },
  },
  // Placed files linked by hand or found by a sync (`PlacedFile.linked`, `found`). Nothing to change: files placed before were all kept
  // where they were while current, and now only linked ones are, so others move to their devices' paths.
  4: { library: (library) => library },
  // Items kept off a device (`Device.excluded`, the excludeDeviceItems and unexcludeDeviceItems operations). Nothing to change.
  5: { library: (library) => library },
  // Dates before AD 1 (`-0570` is 570 BC). Nothing to change: none could be stored before, and the version keeps an older
  // nexlibris, which would read -0570 as AD 570, from syncing with one that has them.
  6: { library: (library) => library },
  // Positions set aside from Currently Reading (`ReadingPosition.setAside`). Nothing to change: none were before, and the
  // version keeps an older nexlibris, whose merge would drop the mark, from syncing with one that has them.
  7: { library: (library) => library },
  // Connections that read, write or both (M13). CrossPoint readers are one type with a Model setting, and its catalogs
  // are the OPDS static export with the formats they took. Files are sent as stored, so placed files lose the key of the
  // metadata written into them as they were sent, and the copies there count as current. Catalogs of particular files
  // (`Device.files`), files' metadata fingerprints (`FileRef.metadataKey`) and the operations setting them are new.
  8: {
    library: (library) => {
      const devices = library.devices as Record<string, StoredDevice> | undefined;
      if (!devices) return library;
      return { ...library, devices: Object.fromEntries(Object.entries(devices).map(([id, device]) => [id, connection9(device)])) };
    },
    operation: (op) => {
      if (op.type === 'addDevice') return { ...op, device: connection9(op.device as StoredDevice) };
      if (op.type === 'recordDeviceSync') return { ...op, placed: unkeyed(op.placed as Record<string, Record<string, unknown>>) };
      return op;
    },
  },
};

type StoredDevice = { type: string; settings: Record<string, MetadataValue>; placed?: Record<string, Record<string, unknown>> } & Record<string, unknown>;

/** Connection types before schema 9 that are another type's now, with the settings that say what they were. */
const RETYPED: Record<string, { type: string; settings: Record<string, string> }> = {
  'crosspoint.x4': { type: 'crosspoint.reader', settings: { model: 'X4' } },
  'crosspoint.x3': { type: 'crosspoint.reader', settings: { model: 'X3' } },
  'crosspoint.x4-catalog': { type: 'opds.catalog', settings: { formats: 'x4.epub,epub' } },
  'crosspoint.x3-catalog': { type: 'opds.catalog', settings: { formats: 'x3.epub,epub' } },
};

function connection9(device: StoredDevice): StoredDevice {
  const retyped = RETYPED[device.type];
  const settings = retyped ? { ...device.settings, ...retyped.settings } : device.settings;
  return { ...device, type: retyped?.type ?? device.type, settings, ...(device.placed && { placed: unkeyed(device.placed) }) };
}

function unkeyed(placed: Record<string, Record<string, unknown>>): Record<string, Record<string, unknown>> {
  return Object.fromEntries(
    Object.entries(placed).map(([path, file]) => {
      const { key: _key, ...rest } = file;
      return [path, rest];
    }),
  );
}

type StoredItem = { metadata: Record<string, MetadataValue> } & Record<string, unknown>;

export class NewerSchemaError extends Error {
  constructor(readonly version: number) {
    super(`This library was saved by a newer version of nexlibris (schema ${version}; this one reads up to ${SCHEMA_VERSION}). Update nexlibris to open it.`);
    this.name = 'NewerSchemaError';
  }
}

function versionOf(value: unknown): number {
  const version = (value as { schemaVersion?: unknown } | null)?.schemaVersion;
  if (typeof value !== 'object' || value === null || typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
    throw new Error('This is not a nexlibris library.');
  }
  return version;
}

function steps(from: number, migrations: Record<number, Migration>, current: number): Migration[] {
  if (from > current) throw new NewerSchemaError(from);
  const list: Migration[] = [];
  for (let version = from; version < current; version++) {
    const step = migrations[version];
    if (!step) throw new Error(`No migration from schema ${version}.`);
    list.push(step);
  }
  return list;
}

/** A stored library at the current schema version, migrated if it's older. */
export function migrateLibrary(
  value: unknown,
  migrations: Record<number, Migration> = MIGRATIONS,
  current: number = SCHEMA_VERSION,
): Library {
  const from = versionOf(value);
  let library = value as Record<string, unknown>;
  steps(from, migrations, current).forEach((step, i) => {
    library = { ...step.library(library), schemaVersion: from + i + 1 };
  });
  return library as unknown as Library;
}

/** An operation logged at schema `from`, as the current version's. */
export function migrateOperation(
  op: Operation,
  from: number,
  migrations: Record<number, Migration> = MIGRATIONS,
  current: number = SCHEMA_VERSION,
): Operation {
  let migrated = op as unknown as Record<string, unknown>;
  for (const step of steps(from, migrations, current)) if (step.operation) migrated = step.operation(migrated);
  return migrated as unknown as Operation;
}
