import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { appFile } from './appProtocol';
import { storeStream } from './importService';
import { folderHolds, moveLibrary, placedFile, pruneWithin } from './libraryFolder';

const tempDir = () => realpathSync(mkdtempSync(join(tmpdir(), 'nexlibris-folder-')));
const hashA = 'a'.repeat(64);
const hashB = 'b'.repeat(64);
const write = (file: string, text: string) => {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
};
const read = (file: string) => readFileSync(file, 'utf8');

/** A library as the data folder keeps it, with two stored files. */
function dataFolderLibrary() {
  const dir = join(tempDir(), 'library');
  write(join(dir, 'library.json'), '{"items":{}}');
  write(join(dir, 'changes.jsonl'), '');
  write(join(dir, 'local', 'sync-host.json'), '{}');
  write(join(dir, 'files', 'aa', hashA), 'dune');
  write(join(dir, 'files', 'bb', hashB), 'cover');
  return dir;
}

const layout = { folder: '<author>/<title>', fileName: '<title>' };

describe('moving the library', () => {
  it('lays it out in a folder of the user’s, leaving what else is there, and deletes the old one', async () => {
    const from = dataFolderLibrary();
    const to = tempDir();
    write(join(to, 'notes.txt'), 'mine');
    const progress: number[] = [];
    await moveLibrary({ from, to, layout, placed: { [hashA]: 'Frank Herbert/Dune/Dune.epub' }, onProgress: (done) => progress.push(done) });

    expect(read(join(to, 'Frank Herbert', 'Dune', 'Dune.epub'))).toBe('dune');
    expect(read(join(to, '.nexlibris', 'files', 'bb', hashB))).toBe('cover');
    expect(read(join(to, '.nexlibris', 'library.json'))).toBe('{"items":{}}');
    expect(read(join(to, '.nexlibris', 'local', 'sync-host.json'))).toBe('{}');
    expect(JSON.parse(read(join(to, '.nexlibris', 'placed.json')))).toEqual({ [hashA]: 'Frank Herbert/Dune/Dune.epub' });
    expect(JSON.parse(read(join(to, '.nexlibris', 'layout.json')))).toEqual(layout);
    expect(read(join(to, 'notes.txt'))).toBe('mine');
    expect(existsSync(from)).toBe(false);
    expect(progress).toEqual([1, 2, 3, 4, 5]);
    expect(await placedFile(to, hashA)).toBe(join(to, 'Frank Herbert', 'Dune', 'Dune.epub'));
    expect(await folderHolds(to)).toBe('library');
  });

  it('keeps a file of the user’s where a book would go, putting the book away instead', async () => {
    const from = dataFolderLibrary();
    const to = tempDir();
    write(join(to, 'Dune.epub'), 'mine');
    await moveLibrary({ from, to, layout, placed: { [hashA]: 'Dune.epub' } });
    expect(read(join(to, 'Dune.epub'))).toBe('mine');
    expect(read(join(to, '.nexlibris', 'files', 'aa', hashA))).toBe('dune');
    expect(JSON.parse(read(join(to, '.nexlibris', 'placed.json')))).toEqual({});
  });

  it('moves back to the data folder’s layout, taking only the library from the user’s folder', async () => {
    const first = dataFolderLibrary();
    const folder = tempDir();
    write(join(folder, 'notes.txt'), 'mine');
    await moveLibrary({ from: first, to: folder, layout, placed: { [hashA]: 'Frank Herbert/Dune/Dune.epub' } });
    const back = join(tempDir(), 'library');
    await moveLibrary({ from: folder, to: back });
    expect(read(join(back, 'files', 'aa', hashA))).toBe('dune');
    expect(read(join(back, 'library.json'))).toBe('{"items":{}}');
    expect(readdirSync(folder)).toEqual(['notes.txt']);
  });

  it('refuses a folder with a library, or its own, and puts everything back if a step fails', async () => {
    const from = dataFolderLibrary();
    const other = dataFolderLibrary();
    await expect(moveLibrary({ from, to: other, layout })).rejects.toThrow(/has a library/);
    await expect(moveLibrary({ from, to: join(from, 'books'), layout })).rejects.toThrow(/its own folder/);

    const to = tempDir();
    // A folder where library.json would go makes that step fail, after the files have moved.
    mkdirSync(join(to, '.nexlibris', 'library.json', 'x'), { recursive: true });
    await expect(moveLibrary({ from, to, layout, placed: { [hashA]: 'Dune.epub' } })).rejects.toThrow();
    expect(read(join(from, 'files', 'aa', hashA))).toBe('dune');
    expect(read(join(from, 'library.json'))).toBe('{"items":{}}');
    expect(existsSync(join(to, 'Dune.epub'))).toBe(false);
  });

  it('doesn’t store again a book placed in the folder, as when it’s imported again', async () => {
    const hash = createHash('sha256').update('dune').digest('hex');
    const from = join(tempDir(), 'library');
    write(join(from, 'library.json'), '{}');
    write(join(from, 'files', hash.slice(0, 2), hash), 'dune');
    const to = tempDir();
    await moveLibrary({ from, to, layout, placed: { [hash]: 'Frank Herbert/Dune/Dune.epub' } });

    const data = join(to, '.nexlibris');
    expect(await storeStream(data, [Buffer.from('dune')])).toEqual({ hash, size: 4 });
    expect(existsSync(join(data, 'files', hash.slice(0, 2), hash))).toBe(false);
    // A book that isn't placed is stored as ever.
    const other = await storeStream(data, [Buffer.from('emma')]);
    expect(read(join(data, 'files', other.hash.slice(0, 2), other.hash))).toBe('emma');
  });

  it('prunes emptied folders, as far as the library’s', async () => {
    const root = tempDir();
    write(join(root, 'A', 'B', '.DS_Store'), '');
    write(join(root, 'A', 'keep.txt'), '');
    await pruneWithin(root, 'A/B/gone.epub');
    expect(readdirSync(join(root, 'A'))).toEqual(['keep.txt']);
  });

  it('serves the books placed in a folder, and its thumbnails, but not its data', () => {
    const dirs = { client: tempDir(), library: tempDir(), placed: true };
    expect(appFile('app://nexlibris/library/Frank%20Herbert/Dune.epub', dirs)?.kind).toBe('library');
    expect(appFile('app://nexlibris/library/.nexlibris/local/thumbs/ab/c.jpg', dirs)?.kind).toBe('library');
    expect(appFile('app://nexlibris/library/.nexlibris/library.json', dirs)?.kind).toBe('client');
  });
});
