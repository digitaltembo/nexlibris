/**
 * Minimal persistence that a library backend is built on. Paths are
 * slash-separated and relative to the library's root.
 */
export interface Storage {
  readText(path: string): Promise<string | undefined>;
  writeText(path: string, text: string): Promise<void>;
  appendText(path: string, text: string): Promise<void>;
  readBlob(path: string): Promise<Blob | undefined>;
  writeBlob(path: string, blob: Blob): Promise<void>;
  exists(path: string): Promise<boolean>;
  /** Deletes the file; nothing happens if there's none. */
  remove(path: string): Promise<void>;
  /**
   * Moves a file, replacing any at `to`, where the storage can do it without copying (else callers
   * copy and remove). Used by libraries kept in a folder of the user's (`placedLibrary.ts`).
   */
  move?(from: string, to: string): Promise<void>;
  /** Removes the folder `path` is in, and those above it, while they're empty. */
  prune?(path: string): Promise<void>;
}

/** Moves a file within a storage: by its `move` where it has one, else by copying and removing. */
export async function moveFile(storage: Storage, from: string, to: string): Promise<void> {
  if (from === to) return;
  if (storage.move) return storage.move(from, to);
  const data = await storage.readBlob(from);
  if (!data) throw new Error(`No file: ${from}`);
  await storage.writeBlob(to, data);
  await storage.remove(from);
}

/** A storage's files under `prefix` (`.nexlibris/`), as a storage of their own. */
export function prefixedStorage(storage: Storage, prefix: string): Storage {
  const at = (path: string) => prefix + path;
  return {
    readText: (path) => storage.readText(at(path)),
    writeText: (path, text) => storage.writeText(at(path), text),
    appendText: (path, text) => storage.appendText(at(path), text),
    readBlob: (path) => storage.readBlob(at(path)),
    writeBlob: (path, blob) => storage.writeBlob(at(path), blob),
    exists: (path) => storage.exists(at(path)),
    remove: (path) => storage.remove(at(path)),
    ...(storage.move && { move: (from: string, to: string) => storage.move!(at(from), at(to)) }),
    ...(storage.prune && { prune: (path: string) => storage.prune!(at(path)) }),
  };
}

export class MemoryStorage implements Storage {
  private readonly files = new Map<string, Blob>();

  async readText(path: string) {
    return this.files.get(path)?.text();
  }
  async writeText(path: string, text: string) {
    this.files.set(path, new Blob([text]));
  }
  async appendText(path: string, text: string) {
    const existing = this.files.get(path);
    this.files.set(path, new Blob(existing ? [existing, text] : [text]));
  }
  async readBlob(path: string) {
    return this.files.get(path);
  }
  async writeBlob(path: string, blob: Blob) {
    this.files.set(path, blob);
  }
  async exists(path: string) {
    return this.files.has(path);
  }
  async remove(path: string) {
    this.files.delete(path);
  }
  async move(from: string, to: string) {
    const data = this.files.get(from);
    if (!data) throw new Error(`No file: ${from}`);
    this.files.delete(from);
    this.files.set(to, data);
  }
  async prune() {
    // Folders exist only as paths' prefixes here.
  }
  /** Every file's path, for tests. */
  allPaths(): string[] {
    return [...this.files.keys()].sort();
  }
}
