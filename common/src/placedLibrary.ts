import { hashBlob, StoredLibraryBackend, type LibraryBackend } from './backend';
import { storedFilePath } from './importApi';
import type { Operation } from './operations';
import { moveFile, prefixedStorage, type Storage } from './storage';
import type { FileHash, Library } from './types';

/**
 * A library kept in a folder of the user's, with its books where a person would look for them:
 * `Frank Herbert/Dune/Dune.epub`, by path templates (`FileLayout`, the same as a CrossPoint
 * reader's). nexlibris's own files go in `.nexlibris/` inside it: the library, its change log and
 * local state as `StoredLibraryBackend` keeps them, covers, and files no book has (yet), which wait
 * content-addressed in `.nexlibris/files/` as in any library. Which file is where is kept in
 * `.nexlibris/placed.json`, by hash, so the library's file references stay hashes.
 *
 * Files are put in place after each change to the library (and when the library opens), in the
 * background: a book's files move when its details change the path, and go back into
 * `.nexlibris/files/` when no book has them.
 */

export const DATA_DIR = '.nexlibris';
const DATA_PREFIX = `${DATA_DIR}/`;
/** The layout a folder's library uses; its being there marks the folder as one. */
export const LAYOUT_PATH = `${DATA_PREFIX}layout.json`;
/** Where each placed file is, by hash. */
export const PLACED_PATH = `${DATA_PREFIX}placed.json`;

/** Where books go in the folder, as path templates (`client/src/devices/pathTemplate.ts`). */
export interface FileLayout {
  /** Each book's folder, e.g. `<author>/<title>`. */
  folder: string;
  /** Its files' names, without the extension, e.g. `<title>`. */
  fileName: string;
}

/**
 * Where the library's book files belong, by hash: paths relative to the folder, none the same
 * (ignoring case), none in `.nexlibris/`. `current` is where they are now, to keep a file where
 * it is while that still fits (so another book's arriving doesn't rename it).
 */
export type Placer = (library: Library, layout: FileLayout, current: ReadonlyMap<FileHash, string>) => Map<FileHash, string>;

export interface PlacingProgress {
  done: number;
  total: number;
}

/** The library paths the desktop app serves by URL: stored files, thumbnails, and books placed in a folder. */
export function servedLibraryPath(path: string, placed: boolean): boolean {
  if (placed && !path.startsWith(DATA_PREFIX)) return !path.startsWith('.') && !path.includes('/.');
  const inner = placed ? path.slice(DATA_PREFIX.length) : path;
  return inner.startsWith('files/') || inner.startsWith('local/thumbs/');
}

export async function readLayout(root: Storage): Promise<FileLayout | undefined> {
  const text = await root.readText(LAYOUT_PATH);
  return text ? (JSON.parse(text) as FileLayout) : undefined;
}

/** How many moves are made before where files are is saved; a crash loses at most these, which are found again. */
const SAVE_EVERY = 25;

export class PlacedLibraryBackend implements LibraryBackend {
  private readonly data: Storage;
  private readonly inner: StoredLibraryBackend;
  private placed: Map<FileHash, string> | undefined;
  /** Where the last placing wanted each file, to find one moved before `placed` was saved. */
  private wanted = new Map<FileHash, string>();
  private placing: Promise<void> = Promise.resolve();
  private again = false;
  private running = false;
  private readonly listeners = new Set<(progress: PlacingProgress | undefined) => void>();

  constructor(
    private readonly root: Storage,
    private layout: FileLayout,
    private readonly placer: Placer,
    defaultName?: string,
  ) {
    this.data = prefixedStorage(root, DATA_PREFIX);
    this.inner = new StoredLibraryBackend(this.data, defaultName);
  }

  /** Opens the library in a folder, writing `layout` if it's a new one, and puts its files in place. */
  static async open(root: Storage, placer: Placer, layout?: FileLayout, defaultName?: string): Promise<PlacedLibraryBackend> {
    const stored = await readLayout(root);
    const chosen = stored ?? layout;
    if (!chosen) throw new Error('This folder has no library layout.');
    if (!stored) await root.writeText(LAYOUT_PATH, JSON.stringify(chosen));
    const backend = new PlacedLibraryBackend(root, chosen, placer, defaultName);
    void backend.place();
    return backend;
  }

  get fileLayout(): FileLayout {
    return this.layout;
  }

  /** Changes where books go, and moves them there. */
  async setLayout(layout: FileLayout): Promise<void> {
    await this.root.writeText(LAYOUT_PATH, JSON.stringify(layout));
    this.layout = layout;
    await this.place();
  }

  /** Hears how putting files in place is going: undefined once it's done. Returns the way to stop. */
  onPlacing(listener: (progress: PlacingProgress | undefined) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Puts the files where the layout wants them; resolves once they all are (for tests, and after a change of layout). */
  place(): Promise<void> {
    // One run at a time; changes made during a run get one more after it.
    if (this.running) {
      this.again = true;
      return this.placing;
    }
    this.running = true;
    this.placing = (async () => {
      try {
        do {
          this.again = false;
          await this.placeAll();
        } while (this.again);
      } finally {
        this.running = false;
        for (const listener of this.listeners) listener(undefined);
      }
    })();
    return this.placing;
  }

  getLibrary(): Promise<Library> {
    return this.inner.getLibrary();
  }

  async apply(ops: Operation[], expectRevision?: number): Promise<Library> {
    const library = await this.inner.apply(ops, expectRevision);
    void this.place().catch(() => undefined);
    return library;
  }

  getChanges(sinceRevision: number) {
    return this.inner.getChanges(sinceRevision);
  }

  async putFile(data: Blob): Promise<{ hash: FileHash; size: number }> {
    const hash = await hashBlob(data);
    if (!(await this.locate(hash))) await this.data.writeBlob(storedFilePath(hash), data);
    // A file a book already has (one fetched from a hub, say) goes where it belongs.
    void this.place().catch(() => undefined);
    return { hash, size: data.size };
  }

  async getFile(hash: FileHash): Promise<Blob | undefined> {
    const path = (await this.locate(hash)) ?? (await this.settled(() => this.locate(hash)));
    return path ? this.root.readBlob(path) : undefined;
  }

  async hasFile(hash: FileHash): Promise<boolean> {
    return (await this.locate(hash)) !== undefined || (await this.settled(() => this.locate(hash))) !== undefined;
  }

  async deleteFile(hash: FileHash): Promise<void> {
    await this.settled(async () => {
      const placed = await this.loadPlaced();
      const path = placed.get(hash);
      if (path) {
        await this.root.remove(path);
        await this.root.prune?.(path);
        placed.delete(hash);
        await this.savePlaced();
      }
      await this.inner.deleteFile(hash);
    });
  }

  readLocalState<T>(key: string) {
    return this.inner.readLocalState<T>(key);
  }
  writeLocalState(key: string, value: unknown) {
    return this.inner.writeLocalState(key, value);
  }
  readLocalFile(path: string) {
    return this.inner.readLocalFile(path);
  }
  writeLocalFile(path: string, data: Blob) {
    return this.inner.writeLocalFile(path, data);
  }
  deleteLocalFile(path: string) {
    return this.inner.deleteLocalFile(path);
  }

  /** Where a stored file is now: placed, waiting in `.nexlibris/files/`, or moved before that was saved. */
  private async locate(hash: FileHash): Promise<string | undefined> {
    const placed = (await this.loadPlaced()).get(hash);
    if (placed && (await this.root.exists(placed))) return placed;
    const waiting = DATA_PREFIX + storedFilePath(hash);
    if (await this.root.exists(waiting)) return waiting;
    const wanted = this.wanted.get(hash);
    if (wanted && wanted !== placed && (await this.root.exists(wanted))) return wanted;
    return undefined;
  }

  /** Runs `task` once no files are moving, so it sees them where they are. */
  private async settled<T>(task: () => Promise<T>): Promise<T> {
    await this.placing.catch(() => undefined);
    return task();
  }

  private async loadPlaced(): Promise<Map<FileHash, string>> {
    if (!this.placed) {
      const text = await this.root.readText(PLACED_PATH);
      this.placed = new Map(Object.entries(text ? (JSON.parse(text) as Record<FileHash, string>) : {}));
    }
    return this.placed;
  }

  private async savePlaced(): Promise<void> {
    await this.root.writeText(PLACED_PATH, JSON.stringify(Object.fromEntries(this.placed ?? [])));
  }

  private async placeAll(): Promise<void> {
    const library = await this.inner.getLibrary();
    const placed = await this.loadPlaced();
    const wanted = this.placer(library, this.layout, placed);
    this.wanted = wanted;
    const at = new Map([...placed].map(([hash, path]) => [path.toLowerCase(), hash]));
    const waiting = (hash: FileHash) => DATA_PREFIX + storedFilePath(hash);
    const moves = [...wanted].filter(([hash, path]) => placed.get(hash) !== path);
    const leaving = [...placed.keys()].filter((hash) => !wanted.has(hash));
    const total = moves.length + leaving.length;
    if (!total) return;
    let done = 0;
    let unsaved = 0;
    const step = async () => {
      done++;
      for (const listener of this.listeners) listener({ done, total });
      if (++unsaved >= SAVE_EVERY) {
        unsaved = 0;
        await this.savePlaced();
      }
    };
    /** Takes a file out of the folder, back into `.nexlibris/files/`. */
    const putAway = async (hash: FileHash) => {
      const from = placed.get(hash)!;
      if (await this.root.exists(from)) {
        await moveFile(this.root, from, waiting(hash));
        await this.root.prune?.(from);
      }
      placed.delete(hash);
      at.delete(from.toLowerCase());
    };

    try {
      for (const hash of leaving) {
        await putAway(hash);
        await step();
      }
      for (const [hash, path] of moves) {
        const from = placed.get(hash);
        const source = from && (await this.root.exists(from)) ? from : (await this.root.exists(waiting(hash))) ? waiting(hash) : undefined;
        if (source) {
          // Another file in the way is one that's moving too, later on: it waits meanwhile.
          const occupant = at.get(path.toLowerCase());
          if (occupant && occupant !== hash) await putAway(occupant);
          if (!(await this.root.exists(path))) {
            await moveFile(this.root, source, path);
            if (from) {
              await this.root.prune?.(from);
              at.delete(from.toLowerCase());
            }
            placed.set(hash, path);
            at.set(path.toLowerCase(), hash);
          }
          // Else something that isn't the library's is there: the file waits in `.nexlibris/files/`.
        } else if (await this.root.exists(path)) {
          // Moved there before a crash kept `placed` from saying so.
          placed.set(hash, path);
          at.set(path.toLowerCase(), hash);
        }
        await step();
      }
    } finally {
      await this.savePlaced();
    }
  }
}
