import {
  createMessageClient,
  createMessageHandler,
  RpcStorage,
  saveApiMeta,
  saveOverRpc,
  storageApiMeta,
  StoredLibraryBackend,
  hashBlob,
  createItem,
  importApiMeta,
  STORE_BATCH_FILES,
  storedFilePath,
  type RpcRequest,
} from '@nexlibris/common';
import { mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { appFile, isAppUrl, isReaderUrl } from './appProtocol';
import { createFileStorage, resolveLibraryPath } from './fileStorage';
import { createImportService } from './importService';
import { createSaveService } from './saveService';

const tempDir = () => realpathSync(mkdtempSync(join(tmpdir(), 'nexlibris-desktop-')));

/** The client's view of the main process: the real handler, called as IPC would. */
function connect(root: string, saveDir = join(tempDir(), 'save'), choose = async () => undefined as string | undefined) {
  const handle = createMessageHandler(
    { ...storageApiMeta, ...saveApiMeta },
    { storage: createFileStorage(root), save: createSaveService(saveDir, choose) },
  );
  let id = 1;
  const send = async (request: RpcRequest) => {
    const response = await handle({ id: id++, ...request });
    if (!response.ok) throw new Error(response.message);
    return response.value;
  };
  return { storage: createMessageClient(storageApiMeta, send).storage, save: createMessageClient(saveApiMeta, send).save };
}

describe('desktop file storage', () => {
  it('keeps a library in native files', async () => {
    const root = tempDir();
    const storage = new RpcStorage(connect(root).storage, 1000);
    const backend = new StoredLibraryBackend(storage);
    const bytes = new Uint8Array(2500).map((_, i) => i % 251);
    const { hash } = await backend.putFile(new Blob([bytes]));
    await backend.apply([{ type: 'addItem', item: createItem({ title: 'Dune' }) }]);

    // On disk, where a new backend over the same folder finds it.
    expect(readFileSync(join(root, 'files', hash.slice(0, 2), hash))).toEqual(Buffer.from(bytes));
    const reopened = new StoredLibraryBackend(new RpcStorage(connect(root).storage));
    expect(Object.values((await reopened.getLibrary()).items).map((i) => i.title)).toEqual(['Dune']);
    expect(new Uint8Array(await (await reopened.getFile(hash))!.arrayBuffer())).toEqual(bytes);
    // No temporary files left behind.
    expect(readdirSync(join(root, 'files', hash.slice(0, 2)))).toEqual([hash]);
    expect(await storage.readBlob('files/00/missing')).toBeUndefined();

    // Deleting: the file goes, deleting it again does nothing, and folders are refused.
    await backend.deleteFile(hash);
    expect(await backend.hasFile(hash)).toBe(false);
    expect(readdirSync(join(root, 'files', hash.slice(0, 2)))).toEqual([]);
    await backend.deleteFile(hash);
    await expect(storage.remove('files')).rejects.toThrow('Not a file');
    await expect(storage.remove('../x')).rejects.toThrow('Bad path');
  });

  it('refuses paths outside the library, including through symlinks', async () => {
    const root = tempDir();
    const outside = tempDir();
    writeFileSync(join(outside, 'secret'), 'secret');
    symlinkSync(outside, join(root, 'link'));
    const { storage } = connect(root);
    for (const path of ['', '/etc/passwd', '../x', 'a/../../x', 'a//b', 'a\\..\\b', './x']) {
      await expect(storage.readText({ path }), path).rejects.toThrow('Bad path');
    }
    await expect(storage.readText({ path: 'link/secret' })).rejects.toThrow('Bad path');
    await expect(storage.writeText({ path: 'link/new', text: 'x' })).rejects.toThrow('Bad path');
    expect(resolveLibraryPath(root, 'files/ab/abcd')).toBe(join(root, 'files', 'ab', 'abcd'));
  });

  it('saves files where the user chooses, or nowhere if they cancel', async () => {
    const out = join(tempDir(), 'backup.zip');
    const saveDir = join(tempDir(), 'save');
    let chosen: string | undefined = out;
    const { save } = connect(tempDir(), saveDir, async () => chosen);
    expect(await saveOverRpc(save, new Blob(['zip bytes']), 'backup.zip', 4)).toBe(true);
    expect(readFileSync(out, 'utf8')).toBe('zip bytes');
    chosen = undefined;
    expect(await saveOverRpc(save, new Blob(['more']), 'backup.zip')).toBe(false);
    expect(readdirSync(saveDir)).toEqual([]);
    await expect(save.chunk({ token: '../x', data: '', first: true })).rejects.toThrow('Bad token');
  });
});

describe('app protocol', () => {
  const client = tempDir();
  const library = tempDir();
  mkdirSync(join(library, 'files', 'ab'), { recursive: true });
  const dirs = { client, library };

  it('serves the client and stored files, and nothing else', () => {
    expect(appFile('app://nexlibris/', dirs)).toEqual({ kind: 'client', file: join(client, 'index.html') });
    expect(appFile('app://nexlibris/assets/index-abc.js', dirs)).toEqual({ kind: 'client', file: join(client, 'assets', 'index-abc.js') });
    expect(appFile('app://nexlibris/library/files/ab/abcd', dirs)).toEqual({ kind: 'library', file: join(library, 'files', 'ab', 'abcd') });
    expect(appFile('app://nexlibris/library/local/thumbs/ab/abcd.jpg', dirs)).toEqual({
      kind: 'library',
      file: join(library, 'local', 'thumbs', 'ab', 'abcd.jpg'),
    });
    // Only stored files and thumbnails: not the library's JSON, change log or other local state.
    expect(appFile('app://nexlibris/library/local/sync-host.json', dirs)?.kind).toBe('client');
    expect(appFile('app://nexlibris/library/library.json', dirs)).toEqual({ kind: 'client', file: join(client, 'library', 'library.json') });
    // Dot segments are resolved by the URL parser, within the origin; encoded slashes survive it, and are refused.
    expect(appFile('app://nexlibris/library/files/%2e%2e/%2e%2e/library.json', dirs)?.file).toBe(join(client, 'library.json'));
    expect(appFile('app://nexlibris/library/files/ab%2F..%2F..%2Flibrary.json', dirs)).toBeUndefined();
    expect(appFile('app://nexlibris/..%2F..%2Fetc%2Fpasswd', dirs)).toBeUndefined();
    expect(appFile('app://other/index.html', dirs)).toBeUndefined();
    expect(appFile('file:///etc/passwd', dirs)).toBeUndefined();
    expect([isAppUrl('app://nexlibris/'), isAppUrl('app://nexlibris.evil/'), isAppUrl('about:blank'), isAppUrl('x')]).toEqual([true, false, false, false]);
    // A book's own window, which the app opens; any other window it's asked for, it doesn't.
    expect([isReaderUrl('app://nexlibris/?read=i&file=h'), isReaderUrl('app://nexlibris/'), isReaderUrl('https://evil.example/?read=i')]).toEqual([true, false, false]);
  });
});

describe('desktop import', () => {
  it('stores picked files by the hash the page uses, and skips others', async () => {
    const root = tempDir();
    const picked = tempDir();
    writeFileSync(join(picked, 'Book.EPUB'), 'hello');
    writeFileSync(join(picked, 'notes.doc'), 'nope');
    let offered: string[] = [];
    const service = createImportService(root, async ({ extensions }) => {
      offered = extensions;
      return [join(picked, 'Book.EPUB'), join(picked, 'notes.doc'), join(picked, 'missing.pdf')];
    });
    const handle = createMessageHandler(importApiMeta, { import: service });
    const send = async (request: RpcRequest) => {
      const response = await handle({ id: 1, ...request });
      if (!response.ok) throw new Error(response.message);
      return response.value;
    };
    const client = createMessageClient(importApiMeta, send).import;
    const chosen = await client.pick({ extensions: ['epub', 'pdf'] });

    expect(offered).toEqual(['epub', 'pdf']);
    // Listed with sizes, not stored yet.
    expect(chosen.files).toEqual([
      { name: 'Book.EPUB', size: 5 },
      { name: 'missing.pdf', size: 0 },
    ]);
    expect(chosen.skipped).toEqual([{ name: 'notes.doc', reason: 'unsupported file type' }]);
    expect(readdirSync(root)).not.toContain('files');

    const result = await client.store({ token: chosen.token, start: 0 });
    const hash = await hashBlob(new Blob(['hello']));
    expect(result.files).toEqual([{ name: 'Book.EPUB', hash, size: 5 }]);
    expect(result.skipped.map((s) => s.name)).toEqual(['missing.pdf']);
    expect(result.next).toBe(2);
    expect(readFileSync(join(root, storedFilePath(hash)), 'utf8')).toBe('hello');
    // Once it's all stored, the pick is let go.
    await expect(client.store({ token: chosen.token, start: 2 })).rejects.toThrow(/pick the files again/);
    // The page's backend finds it already stored, and nothing temporary is left.
    expect(await new StoredLibraryBackend(new RpcStorage(connect(root).storage)).getFile(hash).then((b) => b?.text())).toBe('hello');
    expect(readdirSync(join(root, 'files')).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });
  it('stores the books in a picked folder and its subfolders, with their paths and the named sidecars', async () => {
    const root = tempDir();
    const picked = join(tempDir(), 'Calibre Library');
    const book = join(picked, 'Frank Herbert', 'Dune (7)');
    mkdirSync(book, { recursive: true });
    mkdirSync(join(picked, '.caltrash'));
    writeFileSync(join(book, 'Dune.epub'), 'epub');
    writeFileSync(join(book, 'Metadata.OPF'), '<package/>');
    writeFileSync(join(book, 'cover.jpg'), 'jpeg');
    writeFileSync(join(picked, 'metadata.db'), 'sqlite');
    writeFileSync(join(picked, '.caltrash', 'old.epub'), 'gone');
    let asked: unknown;
    const service = createImportService(root, async (options) => {
      asked = options;
      return [picked];
    });
    const chosen = await service.pick({ extensions: ['epub'], folder: true, names: ['metadata.opf', 'cover.jpg'] });
    const result = await service.store({ token: chosen.token, start: 0 });

    expect(asked).toEqual({ extensions: ['epub'], folder: true });
    expect(result.files.map(({ name, path }) => [name, path])).toEqual([
      ['Dune.epub', 'Calibre Library/Frank Herbert/Dune (7)/Dune.epub'],
      ['Metadata.OPF', 'Calibre Library/Frank Herbert/Dune (7)/Metadata.OPF'],
      ['cover.jpg', 'Calibre Library/Frank Herbert/Dune (7)/cover.jpg'],
    ]);
    expect(readFileSync(join(root, storedFilePath(result.files[0]!.hash)), 'utf8')).toBe('epub');
    // Hidden folders aren't looked in; other files are reported by path.
    expect(chosen.skipped).toEqual([{ name: 'Calibre Library/metadata.db', reason: 'unsupported file type' }]);
  });

  it('stores a pick in batches, and only the latest pick', async () => {
    const picked = tempDir();
    const paths = Array.from({ length: STORE_BATCH_FILES + 10 }, (_, i) => join(picked, `book-${i}.epub`));
    for (const [i, path] of paths.entries()) writeFileSync(path, `book ${i}`);
    const service = createImportService(tempDir(), async () => paths);
    const first = await service.pick({ extensions: ['epub'] });
    const batch = await service.store({ token: first.token, start: 0 });
    expect([batch.files.length, batch.next]).toEqual([STORE_BATCH_FILES, STORE_BATCH_FILES]);

    const second = await service.pick({ extensions: ['epub'] });
    await expect(service.store({ token: first.token, start: batch.next })).rejects.toThrow(/replaced/);
    const rest = await service.store({ token: second.token, start: STORE_BATCH_FILES });
    expect([rest.files.length, rest.next]).toEqual([10, paths.length]);
  });
});
