import { describe, expect, it } from 'vitest';
import { StoredLibraryBackend } from './backend';
import { applyOperations, createDevice, createItem, createLibrary, type Operation } from './operations';
import { scopeChanges, scopeLibrary, scopeOf } from './scope';
import { MemoryStorage } from './storage';
import { createSyncService } from './sync';
import { LOCAL_USER } from './types';

const dune = createItem({ title: 'Dune', tags: ['travel'], files: [{ hash: 'dune-file', size: 1, format: 'epub' }] });
const emma = createItem({ title: 'Emma', files: [{ hash: 'emma-file', size: 1, format: 'epub' }] });
const reader = createDevice({ name: 'Reader', type: 'crosspoint.reader' });
const setup: Operation[] = [
  { type: 'addItem', item: dune },
  { type: 'addItem', item: emma },
  { type: 'setRating', userId: LOCAL_USER, itemId: emma.id, rating: 4 },
  { type: 'addDevice', device: reader },
  { type: 'addDeviceItems', id: reader.id, itemIds: [dune.id, emma.id] },
  { type: 'recordDeviceSync', id: reader.id, placed: { '/Emma.epub': { itemId: emma.id, hash: 'e', size: 1 } }, removed: ['/Old Emma.epub'] },
];
const library = applyOperations(createLibrary('Mine'), setup).library;
const travel = (item: { tags: string[] }) => item.tags.includes('travel');

describe('scope', () => {
  it('is the books the rule picks and the ones the instance has', () => {
    expect(scopeOf(library, undefined)).toBeUndefined();
    expect([...scopeOf(library, travel)!]).toEqual([dune.id]);
    expect([...scopeOf(library, travel, [emma.id, 'gone'])!].sort()).toEqual([dune.id, emma.id].sort());
  });

  it('leaves out other books and everything that names them', () => {
    const scoped = scopeLibrary(library, new Set([dune.id]));
    expect(Object.keys(scoped.items)).toEqual([dune.id]);
    expect(scoped.userData[LOCAL_USER]!.ratings).toEqual({});
    expect(scoped.devices![reader.id]).toMatchObject({ items: [dune.id], placed: {} });
    expect(JSON.stringify(scoped)).not.toContain('Emma');
  });

  it('cuts changes down to the books in scope, and drops removed paths', () => {
    const scoped = scopeChanges(setup, new Set([dune.id]));
    expect(scoped).toEqual([
      { type: 'addItem', item: dune },
      { type: 'addDevice', device: reader },
      { type: 'addDeviceItems', id: reader.id, itemIds: [dune.id] },
    ]);
    expect(scopeChanges(setup, new Set([dune.id, emma.id])).at(-1)).toMatchObject({ removed: [] });
  });

  it('keeps a hub’s books from deletion by an instance, and its files to the books it shows it', async () => {
    const backend = new StoredLibraryBackend(new MemoryStorage());
    await backend.apply(setup);
    const service = createSyncService(backend, { name: () => 'Hub', scope: () => travel });
    const { revision } = await backend.getLibrary();
    const result = await service.apply({ ops: [{ type: 'removeItem', id: dune.id }], expectRevision: revision, peer: 'phone', have: [dune.id] });
    expect(Object.keys((await backend.getLibrary()).items)).toHaveLength(2);
    // Files of books it's shown, and of ones it said it has; not others'.
    await service.state({ since: 0, peer: 'phone', have: [] });
    expect(await service.allows({ hash: 'dune-file', peer: 'phone' })).toBe(true);
    expect(await service.allows({ hash: 'emma-file', peer: 'phone' })).toBe(false);
    await service.state({ since: 0, peer: 'phone', have: [dune.id, emma.id] });
    expect(await service.allows({ hash: 'emma-file', peer: 'phone' })).toBe(true);
    // Unscoped, as a folder's hub is, deletions go through.
    const open = createSyncService(backend, { name: () => 'Hub' });
    await open.apply({ ops: [{ type: 'removeItem', id: emma.id }], expectRevision: result.revision });
    expect(Object.keys((await backend.getLibrary()).items)).toEqual([dune.id]);
  });
});
