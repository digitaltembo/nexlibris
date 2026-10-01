import { storedFilePath } from './importApi';
import { migrateLibrary, migrateOperation } from './migrate';
import { applyOperation, applyOperations, createLibrary, OperationError, type Change, type Operation } from './operations';
import type { Storage } from './storage';
import type { FileHash, Library } from './types';

/**
 * What the client talks to. Kept as a flat object of async functions so it can
 * later be exposed over estuary-rpc without changing callers.
 */
export interface LibraryBackend {
  getLibrary(): Promise<Library>;
  /** Applies operations atomically and returns the updated library. */
  apply(ops: Operation[]): Promise<Library>;
  /** Changes with a revision greater than `sinceRevision`, oldest first. */
  getChanges(sinceRevision: number): Promise<Change[]>;
  /** Stores file contents by hash; storing the same contents twice is a no-op. */
  putFile(data: Blob): Promise<{ hash: FileHash; size: number }>;
  getFile(hash: FileHash): Promise<Blob | undefined>;
}

export async function hashBlob(data: Blob): Promise<FileHash> {
  const digest = await crypto.subtle.digest('SHA-256', await data.arrayBuffer());
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

const LIBRARY_PATH = 'library.json';
const CHANGES_PATH = 'changes.jsonl';
const filePath = storedFilePath;

/**
 * A backend over any `Storage`: the library as one JSON document, the change
 * log as JSON lines, and files content-addressed under `files/`.
 */
export class StoredLibraryBackend implements LibraryBackend {
  private library: Library | undefined;
  /** Serializes writes so concurrent `apply` calls can't interleave. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly storage: Storage,
    private readonly defaultName = 'My Library',
  ) {}

  getLibrary(): Promise<Library> {
    return this.enqueue(() => this.load());
  }

  apply(ops: Operation[]): Promise<Library> {
    return this.enqueue(async () => {
      const { library, changes } = applyOperations(await this.load(), ops);
      if (changes.length === 0) return library;
      // Log first: a crash between the two writes leaves a log that is ahead of
      // the snapshot, which is recoverable by replaying it.
      await this.storage.appendText(CHANGES_PATH, changes.map((c) => JSON.stringify(c) + '\n').join(''));
      await this.storage.writeText(LIBRARY_PATH, JSON.stringify(library));
      this.library = library;
      return library;
    });
  }

  async getChanges(sinceRevision: number): Promise<Change[]> {
    return (await this.readChanges()).filter((c) => c.revision > sinceRevision);
  }

  private async readChanges(): Promise<Change[]> {
    const text = (await this.storage.readText(CHANGES_PATH)) ?? '';
    const changes: Change[] = [];
    for (const line of text.split('\n')) {
      if (!line) continue;
      try {
        changes.push(JSON.parse(line) as Change);
      } catch {
        // Only the last line can be cut short, by a crash while it was appended; it was never applied.
      }
    }
    return changes;
  }

  async putFile(data: Blob): Promise<{ hash: FileHash; size: number }> {
    const hash = await hashBlob(data);
    const path = filePath(hash);
    if (!(await this.storage.exists(path))) await this.storage.writeBlob(path, data);
    return { hash, size: data.size };
  }

  getFile(hash: FileHash): Promise<Blob | undefined> {
    return this.storage.readBlob(filePath(hash));
  }

  /**
   * The library as stored, migrated to the current schema, with any logged changes the snapshot
   * lacks replayed: `apply` logs before writing the snapshot, so a crash between the two leaves
   * the log ahead. Either fix-up is saved straight away.
   */
  private async load(): Promise<Library> {
    if (this.library) return this.library;
    const text = await this.storage.readText(LIBRARY_PATH);
    if (text) {
      const stored = JSON.parse(text) as { schemaVersion: number };
      let library = migrateLibrary(stored);
      let changed = library.schemaVersion !== stored.schemaVersion;
      for (const change of await this.getChanges(library.revision)) {
        if (change.revision !== library.revision + 1) break;
        try {
          library = applyOperation(library, migrateOperation(change.op, stored.schemaVersion), change.at);
        } catch (e) {
          if (e instanceof OperationError) break;
          throw e;
        }
        changed = true;
      }
      if (changed) await this.storage.writeText(LIBRARY_PATH, JSON.stringify(library));
      this.library = library;
    } else {
      this.library = createLibrary(this.defaultName);
      await this.storage.writeText(LIBRARY_PATH, JSON.stringify(this.library));
    }
    return this.library;
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const result = this.queue.then(task);
    this.queue = result.catch(() => undefined);
    return result;
  }
}
