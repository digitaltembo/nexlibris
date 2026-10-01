import { describe, expect, it } from 'vitest';
import { applyOperations, createDevice, createItem, createLibrary, OperationError, userData } from './operations';
import { LOCAL_USER } from './types';

const AT = '2026-01-01T00:00:00.000Z';

function libraryWithItem() {
  const item = createItem({ title: 'Dune', creators: [{ name: 'Frank Herbert', role: 'aut' }] }, AT);
  const { library } = applyOperations(createLibrary('Test'), [{ type: 'addItem', item }], AT);
  return { library, item };
}

describe('applyOperations', () => {
  it('adds items and bumps the revision once per operation', () => {
    const { library, item } = libraryWithItem();
    expect(library.revision).toBe(1);
    expect(library.items[item.id]?.title).toBe('Dune');
  });

  it('records a change per operation', () => {
    const { library, item } = libraryWithItem();
    const { library: next, changes } = applyOperations(
      library,
      [
        { type: 'updateItem', id: item.id, patch: { title: 'Dune Messiah' } },
        { type: 'setMetadata', id: item.id, key: 'series', value: 'Dune' },
      ],
      AT,
    );
    expect(next.revision).toBe(3);
    expect(changes.map((c) => c.revision)).toEqual([2, 3]);
    expect(next.items[item.id]).toMatchObject({ title: 'Dune Messiah', metadata: { series: 'Dune' } });
  });

  it('does not mutate the input library', () => {
    const { library, item } = libraryWithItem();
    const before = JSON.stringify(library);
    applyOperations(library, [{ type: 'setMetadata', id: item.id, key: 'k', value: 1 }], AT);
    expect(JSON.stringify(library)).toBe(before);
  });

  it('removes metadata keys when the value is undefined, including after a JSON round trip', () => {
    const { library, item } = libraryWithItem();
    const set = applyOperations(library, [{ type: 'setMetadata', id: item.id, key: 'k', value: 1 }], AT).library;
    const op = JSON.parse(JSON.stringify({ type: 'setMetadata', id: item.id, key: 'k', value: undefined }));
    expect(applyOperations(set, [op], AT).library.items[item.id]?.metadata).toEqual({});
  });

  it('adds tags without case-insensitive duplicates and removes them', () => {
    const { library, item } = libraryWithItem();
    const tagged = applyOperations(
      library,
      [
        { type: 'addTags', id: item.id, tags: ['Sci-Fi', ' classic ', ''] },
        { type: 'addTags', id: item.id, tags: ['sci-fi', 'Desert'] },
      ],
      AT,
    ).library;
    expect(tagged.items[item.id]?.tags).toEqual(['Sci-Fi', 'classic', 'Desert']);
    const untagged = applyOperations(tagged, [{ type: 'removeTags', id: item.id, tags: ['CLASSIC'] }], AT).library;
    expect(untagged.items[item.id]?.tags).toEqual(['Sci-Fi', 'Desert']);
  });

  it('attaches files once per hash and detaches them', () => {
    const { library, item } = libraryWithItem();
    const file = { hash: 'abc', format: 'epub', size: 10 };
    const attached = applyOperations(
      library,
      [
        { type: 'attachFile', id: item.id, file },
        { type: 'attachFile', id: item.id, file },
      ],
      AT,
    ).library;
    expect(attached.items[item.id]?.files).toEqual([file]);
    const detached = applyOperations(attached, [{ type: 'detachFile', id: item.id, hash: 'abc' }], AT).library;
    expect(detached.items[item.id]?.files).toEqual([]);
  });

  it('stores ratings and reviews per user and clears them with the item', () => {
    const { library, item } = libraryWithItem();
    const rated = applyOperations(
      library,
      [
        { type: 'setRating', userId: LOCAL_USER, itemId: item.id, rating: 4 },
        { type: 'setReview', userId: LOCAL_USER, itemId: item.id, text: 'Spice.' },
      ],
      AT,
    ).library;
    expect(userData(rated).ratings[item.id]).toBe(4);
    expect(userData(rated).reviews[item.id]?.text).toBe('Spice.');

    const removed = applyOperations(rated, [{ type: 'removeItem', id: item.id }], AT).library;
    expect(removed.items).toEqual({});
    expect(userData(removed)).toEqual({ ratings: {}, reviews: {} });
  });

  it('remembers one reading position per user and item, cleared with the item', () => {
    const { library, item } = libraryWithItem();
    const position = { hash: 'abc', locator: 'epubcfi(/6/4!/4/2)', progress: 0.25 };
    const read = applyOperations(
      library,
      [
        { type: 'setPosition', userId: LOCAL_USER, itemId: item.id, position: { hash: 'abc', locator: '1' } },
        { type: 'setPosition', userId: LOCAL_USER, itemId: item.id, position },
      ],
      AT,
    ).library;
    expect(userData(read).positions?.[item.id]).toEqual({ ...position, updatedAt: AT });
    expect(() =>
      applyOperations(read, [
        { type: 'setPosition', userId: LOCAL_USER, itemId: item.id, position: { ...position, progress: 2 } },
      ]),
    ).toThrow(OperationError);

    const removed = applyOperations(read, [{ type: 'removeItem', id: item.id }], AT).library;
    expect(userData(removed).positions).toEqual({});
  });

  it('keeps devices: their settings by key, their items, and what syncs placed on them', () => {
    const dune = createItem({ title: 'Dune' });
    const emma = createItem({ title: 'Emma' });
    const x4 = createDevice({ name: 'My X4', type: 'crosspoint.x4', settings: { address: 'http://crosspoint.local' } });
    let { library } = applyOperations(createLibrary('L'), [
      { type: 'addItem', item: dune },
      { type: 'addItem', item: emma },
      { type: 'addDevice', device: x4 },
      { type: 'addDeviceItems', id: x4.id, itemIds: [dune.id, emma.id, dune.id] },
      { type: 'updateDevice', id: x4.id, patch: { name: 'X4', settings: { folder: '/Books', address: undefined } } },
      { type: 'recordDeviceSync', id: x4.id, placed: { '/Books/Dune.epub': { itemId: dune.id, hash: 'h1', size: 1 } }, removed: [] },
    ], '2026-10-01T00:00:00Z');
    expect(library.devices?.[x4.id]).toMatchObject({
      name: 'X4',
      settings: { folder: '/Books' },
      items: [dune.id, emma.id],
      placed: { '/Books/Dune.epub': { itemId: dune.id, hash: 'h1', size: 1 } },
      lastSyncedAt: '2026-10-01T00:00:00Z',
    });

    // Removing an item takes it off the device's list; what the device holds is the next sync's business.
    ({ library } = applyOperations(library, [
      { type: 'removeItem', id: dune.id },
      { type: 'recordDeviceSync', id: x4.id, placed: {}, removed: ['/Books/Dune.epub'] },
      { type: 'removeDeviceItems', id: x4.id, itemIds: [emma.id] },
    ]));
    expect(library.devices?.[x4.id]).toMatchObject({ items: [], placed: {} });

    // A query is set, kept by other patches, and cleared by an empty one.
    ({ library } = applyOperations(library, [{ type: 'updateDevice', id: x4.id, patch: { query: '  tag sci-fi ' } }]));
    expect(library.devices?.[x4.id]?.query).toBe('tag sci-fi');
    ({ library } = applyOperations(library, [{ type: 'updateDevice', id: x4.id, patch: { name: 'Renamed' } }]));
    expect(library.devices?.[x4.id]?.query).toBe('tag sci-fi');
    ({ library } = applyOperations(library, [{ type: 'updateDevice', id: x4.id, patch: { query: ' ' } }]));
    expect(library.devices?.[x4.id]).not.toHaveProperty('query');
    expect(createDevice({ name: 'X3', type: 'crosspoint.x3', query: 'austen' }).query).toBe('austen');

    ({ library } = applyOperations(library, [{ type: 'removeDevice', id: x4.id }]));
    expect(library.devices).toEqual({});
    expect(() => applyOperations(library, [{ type: 'addDeviceItems', id: x4.id, itemIds: [emma.id] }])).toThrow(OperationError);
  });

  it('rejects device items that are not in the library', () => {
    const x4 = createDevice({ name: 'X4', type: 'crosspoint.x4' });
    const { library } = applyOperations(createLibrary('L'), [{ type: 'addDevice', device: x4 }]);
    expect(() => applyOperations(library, [{ type: 'addDeviceItems', id: x4.id, itemIds: ['nope'] }])).toThrow('No item with id nope');
  });

  it('rejects invalid operations without partial application', () => {
    const { library, item } = libraryWithItem();
    expect(() =>
      applyOperations(
        library,
        [
          { type: 'updateItem', id: item.id, patch: { title: 'Changed' } },
          { type: 'setRating', userId: LOCAL_USER, itemId: item.id, rating: 7 },
        ],
        AT,
      ),
    ).toThrow(OperationError);
    expect(library.items[item.id]?.title).toBe('Dune');
    expect(() => applyOperations(library, [{ type: 'removeItem', id: 'missing' }], AT)).toThrow(OperationError);
  });
});
