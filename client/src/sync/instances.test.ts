import { applyOperations, createItem, createLibrary, MemoryStorage, readPairings, savePairing, StoredLibraryBackend, type Library, type Operation } from '@nexlibris/common';
import { describe, expect, it } from 'vitest';
import { addInstances, carryOverPairings, EVERY_BOOK, folderKeepRule, INSTANCE_TYPE, keptBy, pairedConnections } from './instances';

const file = (c: string) => ({ hash: c.repeat(64), size: 1, format: 'epub' });
const reading = createItem({ title: 'Reading', tags: ['reading'], files: [file('a')] });
const shelved = createItem({ title: 'Shelved', files: [file('b')] });
const wanted = createItem({ title: 'Wanted' });

const build = (ops: Operation[] = []) =>
  applyOperations(createLibrary('Books'), [...[reading, shelved, wanted].map((item): Operation => ({ type: 'addItem', item })), ...ops]).library;

describe('instance connections', () => {
  it('adds one per instance, keyed by its origin, keeping every book’s files to start with', () => {
    const library = build();
    const ops = addInstances(library, [
      { origin: 'phone', name: 'Pixel' },
      { origin: 'phone', name: 'Pixel again' },
      { origin: 'desk', name: 'iMac' },
    ]);
    const after = applyOperations(library, ops).library;
    expect(Object.values(after.devices!).map((d) => [d.id, d.name, d.type, d.query])).toEqual([
      ['phone', 'Pixel', INSTANCE_TYPE, EVERY_BOOK],
      ['desk', 'iMac', INSTANCE_TYPE, EVERY_BOOK],
    ]);
    expect(addInstances(after, [{ origin: 'desk', name: 'iMac' }])).toEqual([]);
    // Every book with a file, so a book with none doesn't count.
    const kept = keptBy(after, 'phone')!;
    expect([reading, shelved, wanted].map(kept)).toEqual([true, true, false]);
  });

  it('keeps the files of the books its connection has: chosen ones and its rules’ matches', () => {
    let library: Library = build();
    library = applyOperations(library, addInstances(library, [{ origin: 'phone', name: 'Pixel' }], 'tag:reading')).library;
    library = applyOperations(library, [{ type: 'addDeviceItems', id: 'phone', itemIds: [wanted.id] }]).library;
    const kept = keptBy(library, 'phone')!;
    expect([reading, shelved, wanted].map(kept)).toEqual([true, false, true]);
    // No connection: everything, as before connections.
    expect(keptBy(library, 'elsewhere')).toBeUndefined();
    // A folder hub asks by origin, falling back to what the device recorded in the folder.
    expect(folderKeepRule({ origin: 'phone', keepFiles: 'ignored' }, library)!(shelved)).toBe(false);
    expect(folderKeepRule({ origin: 'elsewhere', keepFiles: 'tag:reading' }, library)!(shelved)).toBe(false);
    expect(folderKeepRule({ origin: 'elsewhere' }, library)).toBeUndefined();
  });

  it('carries pairings made before connections into the library, with the files they kept', async () => {
    const backend = new StoredLibraryBackend(new MemoryStorage(), 'Books');
    const hub = { origin: 'desk', name: 'iMac', libraryName: 'Books' };
    await savePairing(backend, { hub, address: 'http://desk', key: 'k', truth: 'theirs', keepFiles: 'tag:reading' });
    const library = (await carryOverPairings(backend, 'Pixel'))!;
    expect(library.devices![library.origin]).toMatchObject({ name: 'Pixel', type: INSTANCE_TYPE, query: 'tag:reading' });
    expect(library.devices!.desk).toMatchObject({ name: 'iMac', type: INSTANCE_TYPE, query: EVERY_BOOK });
    expect((await readPairings(backend))[0]!.keepFiles).toBeUndefined();
    // Once is enough.
    expect(await carryOverPairings(backend, 'Pixel')).toBeUndefined();
  });

  it('gives a newly paired instance the books the hub chose, and the hub a connection', () => {
    const library = createLibrary('Phone');
    const hub = { origin: 'desktop-origin', name: 'Desktop', libraryName: 'Books' };
    const pairing = { hub, address: 'http://x', key: 'k', truth: 'theirs' as const, chosenFiles: 'tag:travel' };
    const after = applyOperations(library, pairedConnections(library, pairing, 'Pixel')).library;
    expect(after.devices![library.origin]).toMatchObject({ name: 'Pixel', type: INSTANCE_TYPE, query: 'tag:travel' });
    expect(after.devices![hub.origin]).toMatchObject({ name: 'Desktop', query: EVERY_BOOK });

    // Paired again with another choice: this instance's connection takes it; with none, it's left as it is.
    const again = applyOperations(after, pairedConnections(after, { ...pairing, chosenFiles: 'rating:4+' }, 'Pixel')).library;
    expect(again.devices![library.origin]!.query).toBe('rating:4+');
    const { chosenFiles: _, ...plain } = pairing;
    expect(pairedConnections(again, plain, 'Pixel')).toEqual([]);
  });
});
