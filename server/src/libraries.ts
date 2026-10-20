import {
  isFileHash,
  storedFilePath,
  StoredLibraryBackend,
  type Change,
  type CloudLibraryStatus,
  type FileHash,
  type ImportRequest,
  type Library,
  type Storage,
} from '@nexlibris/common';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Readable } from 'node:stream';
import { checkKey, type ObjectStore } from './objectStore';

/**
 * Each account's library: a `StoredLibraryBackend` (one per account, so its writes stay in order)
 * whose library JSON, change log and local files are on the server's disk, in
 * `<data>/accounts/<id>/`, and whose books' files are in the object store, under
 * `[<prefix>]accounts/<id>/files/`. The change log is appended to on every change, which object
 * stores can't do, and it and the library are small beside the books.
 */

const FILES = 'files/';

/** Text and blobs in a folder; `files/…` in the object store. */
class AccountStorage implements Storage {
  constructor(
    private readonly dir: string,
    private readonly files: ObjectStore,
    private readonly filesPrefix: string,
    private readonly tempDir: string,
  ) {}

  private path(path: string) {
    return join(this.dir, ...checkKey(path));
  }
  private key(path: string) {
    return this.filesPrefix + path.slice(FILES.length);
  }

  async readText(path: string) {
    return (await this.readBlob(path))?.text();
  }

  async writeText(path: string, text: string) {
    const file = this.path(path);
    await mkdir(dirname(file), { recursive: true });
    const temp = `${file}.${randomUUID()}.tmp`;
    await writeSynced(temp, text, 'w');
    await rename(temp, file);
  }

  async appendText(path: string, text: string) {
    const file = this.path(path);
    await mkdir(dirname(file), { recursive: true });
    await writeSynced(file, text, 'a');
  }

  async readBlob(path: string) {
    if (path.startsWith(FILES)) {
      const object = await this.files.get(this.key(path));
      return object && new Blob([new Uint8Array(await collect(object.body))]);
    }
    const data = await readFile(this.path(path)).catch((e: NodeJS.ErrnoException) => {
      if (e.code === 'ENOENT' || e.code === 'EISDIR') return undefined;
      throw e;
    });
    return data && new Blob([data]);
  }

  async writeBlob(path: string, blob: Blob) {
    const data = new Uint8Array(await blob.arrayBuffer());
    if (!path.startsWith(FILES)) {
      const file = this.path(path);
      await mkdir(dirname(file), { recursive: true });
      const temp = `${file}.${randomUUID()}.tmp`;
      await writeFile(temp, data);
      await rename(temp, file);
      return;
    }
    await mkdir(this.tempDir, { recursive: true });
    const temp = join(this.tempDir, `${randomUUID()}.tmp`);
    try {
      await writeFile(temp, data);
      await this.files.put(this.key(path), temp, { size: data.length, sha256: createHash('sha256').update(data).digest('hex') });
    } finally {
      await rm(temp, { force: true });
    }
  }

  async exists(path: string) {
    if (path.startsWith(FILES)) return (await this.files.head(this.key(path))) !== undefined;
    return (await stat(this.path(path)).catch(() => undefined))?.isFile() ?? false;
  }

  async remove(path: string) {
    if (path.startsWith(FILES)) return this.files.remove(this.key(path));
    await rm(this.path(path), { force: true });
  }
}

async function writeSynced(file: string, data: string, flags: 'w' | 'a') {
  const handle = await open(file, flags, 0o600);
  try {
    await handle.writeFile(data);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function collect(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

/** Checks a local file's path as the backend does (`localFilePath`): lowercase names, never `..`. */
export function checkLocalPath(path: string): string {
  if (!/^[a-z][a-z0-9-]*(\/[a-z0-9][a-z0-9.-]*)+$/.test(path) || path.split('/').includes('..')) throw new Error(`Bad local file path: ${path}`);
  return path;
}

export function createLibraries(options: { dataDir: string; files: ObjectStore; prefix?: string }) {
  const open = new Map<string, StoredLibraryBackend>();
  const tempDir = join(options.dataDir, 'tmp');
  const dirOf = (accountId: string) => join(options.dataDir, 'accounts', ...checkKey(accountId));
  const filesPrefix = (accountId: string) => `${options.prefix ?? ''}accounts/${checkKey(accountId).join('/')}/files/`;
  const fileKey = (accountId: string, hash: FileHash) => {
    if (!isFileHash(hash)) throw new Error('Bad file hash.');
    return filesPrefix(accountId) + storedFilePath(hash).slice(FILES.length);
  };
  const storage = (accountId: string) => new AccountStorage(dirOf(accountId), options.files, filesPrefix(accountId), tempDir);

  function backend(accountId: string): StoredLibraryBackend {
    let library = open.get(accountId);
    if (!library) {
      library = new StoredLibraryBackend(storage(accountId));
      open.set(accountId, library);
    }
    return library;
  }

  /** Whether the account has a library file at all (opening the backend makes an empty one). */
  const hasLibraryFile = async (accountId: string) => (await stat(join(dirOf(accountId), 'library.json')).catch(() => undefined))?.isFile() ?? false;

  return {
    backend,

    async status(accountId: string): Promise<CloudLibraryStatus> {
      if (!(await hasLibraryFile(accountId))) return { exists: false, items: 0, files: 0, bytes: 0 };
      const library = await backend(accountId).getLibrary();
      const sizes = new Map<FileHash, number>();
      for (const item of Object.values(library.items)) {
        for (const file of item.files) sizes.set(file.hash, file.size);
        if (item.cover) sizes.set(item.cover.hash, sizes.get(item.cover.hash) ?? 0);
      }
      const items = Object.keys(library.items).length;
      return { exists: items > 0 || library.revision > 0, items, files: sizes.size, bytes: [...sizes.values()].reduce((a, b) => a + b, 0) };
    },

    /** Stores an uploaded file, refusing it unless it hashes to `expected`. */
    async storeFile(accountId: string, body: AsyncIterable<Buffer | Uint8Array>, expected: FileHash): Promise<{ size: number }> {
      return storeStream(tempDir, body, expected, (temp, info) => options.files.put(fileKey(accountId, expected), temp, info));
    },

    readFile: (accountId: string, hash: FileHash) => options.files.get(fileKey(accountId, hash)),
    hasFile: async (accountId: string, hash: FileHash) => (await options.files.head(fileKey(accountId, hash))) !== undefined,

    async readLocalFile(accountId: string, path: string): Promise<{ size: number; body: Readable } | undefined> {
      const file = join(dirOf(accountId), 'local', ...checkKey(checkLocalPath(path)));
      const info = await stat(file).catch(() => undefined);
      return info?.isFile() ? { size: info.size, body: createReadStream(file) } : undefined;
    },

    async writeLocalFile(accountId: string, path: string, body: AsyncIterable<Buffer | Uint8Array>): Promise<void> {
      const file = join(dirOf(accountId), 'local', ...checkKey(checkLocalPath(path)));
      await storeStream(tempDir, body, undefined, async (temp) => {
        await mkdir(dirname(file), { recursive: true });
        await rename(temp, file);
      });
    },

    /** Puts a library moved from elsewhere in the account; refused if it has one with anything in it. */
    async import(accountId: string, request: ImportRequest): Promise<void> {
      const { library, changes } = request ?? {};
      if (!isLibrary(library) || !Array.isArray(changes)) throw new Error('That isn’t a nexlibris library.');
      if ((await this.status(accountId)).exists) throw new Error('Your account has a library already.');
      const dir = dirOf(accountId);
      await mkdir(dir, { recursive: true });
      const log = (changes as Change[]).map((change) => JSON.stringify(change) + '\n').join('');
      await writeFile(join(dir, 'changes.jsonl.tmp'), log, { mode: 0o600 });
      await writeFile(join(dir, 'library.json.tmp'), JSON.stringify(library), { mode: 0o600 });
      await rename(join(dir, 'changes.jsonl.tmp'), join(dir, 'changes.jsonl'));
      await rename(join(dir, 'library.json.tmp'), join(dir, 'library.json'));
      open.delete(accountId);
    },

    /** Deletes the account's library: its files, its change log and local files. */
    async remove(accountId: string): Promise<void> {
      open.delete(accountId);
      for (const key of await options.files.list(filesPrefix(accountId))) await options.files.remove(key);
      await rm(dirOf(accountId), { recursive: true, force: true });
    },
  };
}

export type Libraries = ReturnType<typeof createLibraries>;

function isLibrary(value: unknown): value is Library {
  const library = value as Partial<Library> | undefined;
  return (
    !!library &&
    typeof library === 'object' &&
    typeof library.schemaVersion === 'number' &&
    typeof library.origin === 'string' &&
    typeof library.revision === 'number' &&
    !!library.items &&
    typeof library.items === 'object'
  );
}

/**
 * Writes a stream to a temporary file, hashing it as it goes, and hands it to `keep` if it hashes
 * to `expected` (when given). The temporary file is removed either way.
 */
export async function storeStream(
  tempDir: string,
  body: AsyncIterable<Buffer | Uint8Array>,
  expected: string | undefined,
  keep: (temp: string, info: { size: number; sha256: string }) => Promise<void>,
): Promise<{ size: number }> {
  await mkdir(tempDir, { recursive: true });
  const temp = join(tempDir, `${randomUUID()}.tmp`);
  const hash = createHash('sha256');
  let size = 0;
  try {
    const out = await open(temp, 'w', 0o600);
    try {
      for await (const chunk of body) {
        hash.update(chunk);
        size += chunk.length;
        await out.write(chunk);
      }
    } finally {
      await out.close();
    }
    const sha256 = hash.digest('hex');
    if (expected !== undefined && sha256 !== expected) {
      throw new Error(`The file’s contents don’t match its hash (expected ${expected.slice(0, 12)}…, got ${sha256.slice(0, 12)}…).`);
    }
    await keep(temp, { size, sha256 });
    return { size };
  } finally {
    await rm(temp, { force: true });
  }
}
