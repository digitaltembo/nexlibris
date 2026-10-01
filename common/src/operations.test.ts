import { describe, expect, it } from 'vitest';
import { applyOperations, createItem, createLibrary, OperationError, userData } from './operations';
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
