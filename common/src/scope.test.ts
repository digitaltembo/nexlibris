import { describe, expect, it } from 'vitest';
import { StoredLibraryBackend } from './backend';
import { applyOperations, createDevice, createItem, createLibrary, type Operation } from './operations';
import { scopeChanges, scopeLibrary, scopeOf } from './scope';
import { MemoryStorage } from './storage';
import { createSyncService } from './sync';
import { LOCAL_USER } from './types';

const dune = createItem({ title: 'Dune', tags: ['travel'] });
const emma = createItem({ title: 'Emma' });
const reader = createDevice({ name: 'Reader', type: 'crosspoint.x4' });
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

  it('keeps a hub’s books from deletion by an instance it scopes, and says which it has that it no longer picks', async () => {
    const backend = new StoredLibraryBackend(new MemoryStorage());
    await backend.apply(setup);
    const service = createSyncService(backend, { name: () => 'Hub', scope: () => travel });
    const { revision } = await backend.getLibrary();
    const result = await service.apply({ ops: [{ type: 'removeItem', id: dune.id }], expectRevision: revision, peer: 'phone', have: [dune.id, emma.id] });
    expect(Object.keys((await backend.getLibrary()).items)).toHaveLength(2);
    expect(result.outside).toEqual([emma.id]);
    // Unscoped, as a folder's hub is, deletions go through.
    const open = createSyncService(backend, { name: () => 'Hub' });
    await open.apply({ ops: [{ type: 'removeItem', id: emma.id }], expectRevision: result.revision });
    expect(Object.keys((await backend.getLibrary()).items)).toEqual([dune.id]);
  });
});
