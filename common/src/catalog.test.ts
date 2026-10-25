import { describe, expect, it } from 'vitest';
import { deviceItemCount, deviceItems } from './catalog';
import { applyOperations, createDevice, createItem, createLibrary } from './operations';

const dune = createItem({ title: 'Dune', tags: ['travel'] });
const emma = createItem({ title: 'Emma', tags: ['travel'] });
const kim = createItem({ title: 'Kim', tags: ['travel'] });
const ulysses = createItem({ title: 'Ulysses' });

describe('deviceItemCount', () => {
  it('counts what deviceItems gives: the chosen books and the search’s, less those taken out', () => {
    const reader = { ...createDevice({ name: 'Reader', type: 'crosspoint.reader', query: 'tag:travel' }), excluded: [kim.id] };
    const library = applyOperations(createLibrary('Mine'), [
      ...[dune, emma, kim, ulysses].map((item) => ({ type: 'addItem' as const, item })),
      { type: 'addDevice', device: reader },
      { type: 'addDeviceItems', id: reader.id, itemIds: [dune.id, ulysses.id] },
    ]).library;
    // One chosen since deleted.
    const stored = library.devices![reader.id]!;
    const device = { ...stored, items: [...stored.items, 'gone'] };
    expect(deviceItems(library, device).map((i) => i.title).sort()).toEqual(['Dune', 'Emma', 'Ulysses']);
    expect(deviceItemCount(library, device)).toBe(3);
  });
});
