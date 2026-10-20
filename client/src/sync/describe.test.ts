import { applyOperations, createDevice, createItem, createLibrary, type Library } from '@nexlibris/common';
import { describe, expect, it } from 'vitest';
import { describeConflict } from './describe';

function libraries() {
  const dune = createItem({ title: 'Dune', creators: [{ name: 'Frank Herbert', role: 'aut' }] });
  const x4 = createDevice({ name: 'X4', type: 'crosspoint.reader' });
  const ours = applyOperations(createLibrary('A'), [
    { type: 'addItem', item: dune },
    { type: 'addDevice', device: x4 },
  ]).library;
  // Emma is only on the other side, so its name comes from there.
  const emma = createItem({ title: 'Emma' });
  const theirs: Library = applyOperations(ours, [{ type: 'addItem', item: emma }]).library;
  return { dune, emma, x4, libraries: { ours, theirs } };
}

describe('describeConflict', () => {
  it('names the item or device and what about it, with both values', () => {
    const { dune, emma, x4, libraries: l } = libraries();
    const view = (target: never, ours: unknown, theirs: unknown) =>
      describeConflict({ target, ours, theirs, winner: 'theirs' }, l);
    expect(view(['item', dune.id, 'title'] as never, 'Dune', 'Dune (1965)')).toEqual({
      what: 'Dune — title',
      ours: '“Dune”',
      theirs: '“Dune (1965)”',
    });
    expect(view(['item', emma.id] as never, false, true)).toEqual({ what: 'Emma', ours: 'removed', theirs: 'kept' });
    expect(view(['item', dune.id, 'tag', 'classic'] as never, 'Classic', 'classic').what).toBe('Dune — tag “classic”');
    expect(view(['item', dune.id, 'creators'] as never, [{ name: 'Frank Herbert', role: 'aut' }], undefined)).toEqual({
      what: 'Dune — authors',
      ours: 'Frank Herbert',
      theirs: 'none',
    });
    expect(view(['rating', 'local', dune.id] as never, 4, 2)).toEqual({ what: 'Dune — rating', ours: '4 ★', theirs: '2 ★' });
    expect(view(['device', x4.id, 'setting', 'address'] as never, 'http://a', 'http://b').what).toBe('X4 — setting “address”');
    expect(view(['device', x4.id, 'item', dune.id] as never, true, false)).toEqual({
      what: 'X4 — Dune',
      ours: 'on the device',
      theirs: 'not on the device',
    });
    const moods = { id: 'm', name: 'Moods', entries: [{ label: 'Cosy', query: 'tag:cosy' }, { label: '', query: 'tag:dark' }] };
    expect(view(['category', 'm', 'definition'] as never, moods, undefined)).toEqual({
      what: 'Category “A category”',
      ours: '“Moods”: Cosy, tag:dark',
      theirs: 'removed',
    });
  });
});
