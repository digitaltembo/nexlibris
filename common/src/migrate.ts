import type { Operation } from './operations';
import { SCHEMA_VERSION, type Library } from './types';

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

/** `MIGRATIONS[n]` takes version n to n + 1. None yet: version 1 is the first. */
export const MIGRATIONS: Record<number, Migration> = {};

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
