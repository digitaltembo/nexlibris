import { describe, expect, it } from 'vitest';
import { planMerge, type Side } from './merge';
import { differingParts, planRepair, stateDigest } from './repair';
import { applyOperations, createCategory, createDevice, createItem, createLibrary, type Operation } from './operations';
import { LOCAL_USER, type Library } from './types';

const file = (hash: string) => ({ hash: hash.repeat(64).slice(0, 64), size: 10, format: 'epub' as const });

/** A library both instances start from: Dune (tagged, with a file, rated, on a device) and Emma. */
function base() {
  const dune = createItem({ title: 'Dune', tags: ['Fiction'], files: [file('a')] });
  const emma = createItem({ title: 'Emma' });
  const device = createDevice({ name: 'X4', type: 'crosspoint.x4', settings: { address: 'http://x4' } });
  const library = applyOperations(createLibrary('Shared'), [
    { type: 'addItem', item: dune },
    { type: 'addItem', item: emma },
    { type: 'setRating', userId: LOCAL_USER, itemId: dune.id, rating: 4 },
    { type: 'addDevice', device },
    { type: 'addDeviceItems', id: device.id, itemIds: [dune.id] },
  ]).library;
  return { library, dune, emma, device };
}

/** Each side's changes since the base, applied; then merged both ways. */
function merge(start: Library, ours: Operation[], theirs: Operation[], truth: Side = 'ours', at = { ours: '2026-01-01T00:00:00.000Z', theirs: '2026-01-01T00:00:00.000Z' }) {
  const a = applyOperations({ ...start, origin: 'a' }, ours, at.ours).library;
  const b = applyOperations({ ...start, origin: 'b' }, theirs, at.theirs).library;
  const plan = planMerge({ library: a, changes: ours }, { library: b, changes: theirs }, truth);
  const merged = {
    ours: applyOperations(a, plan.ours, '2026-02-01T00:00:00.000Z').library,
    theirs: applyOperations(b, plan.theirs, '2026-02-01T00:00:00.000Z').library,
  };
  // Merging again, with the same changes since the base, finds nothing left to do.
  const again = planMerge({ library: merged.ours, changes: [...ours, ...plan.ours] }, { library: merged.theirs, changes: [...theirs, ...plan.theirs] }, truth);
  expect(again.ours).toEqual([]);
  expect(again.theirs).toEqual([]);
  return { plan, ...merged };
}

/** A library's content, without what's local to an instance or depends on when things were applied. */
function content(library: Library) {
  const sorted = (values: string[]) => [...values].sort();
  return {
    items: Object.fromEntries(
      Object.values(library.items).map(({ updatedAt: _u, ...item }) => [
        item.id,
        { ...item, tags: sorted(item.tags), files: [...item.files].sort((x, y) => x.hash.localeCompare(y.hash)) },
      ]),
    ),
    userData: Object.fromEntries(
      Object.entries(library.userData).map(([user, data]) => [
        user,
        {
          ratings: data.ratings,
          reviews: Object.fromEntries(Object.entries(data.reviews).map(([id, r]) => [id, r.text])),
          positions: Object.fromEntries(Object.entries(data.positions ?? {}).map(([id, { updatedAt: _u, ...p }]) => [id, p])),
        },
      ]),
    ),
    devices: Object.fromEntries(
      Object.values(library.devices ?? {}).map(({ lastSyncedAt: _l, ...d }) => [d.id, { ...d, items: sorted(d.items) }]),
    ),
    categories: library.categories ?? {},
  };
}

const agree = (result: { ours: Library; theirs: Library }) => {
  expect(content(result.ours)).toEqual(content(result.theirs));
  // The state hash agrees too: the check after a merge would find nothing to repair.
  expect(stateDigest(result.ours).hash).toBe(stateDigest(result.theirs).hash);
};

describe('planMerge', () => {
  it('takes new categories both ways, and settles one edited on both sides by the source of truth', () => {
    const { library } = base();
    const moods = createCategory({ name: 'Moods', entries: [{ label: 'Cosy', query: 'tag:cosy' }] });
    const start = applyOperations(library, [{ type: 'setCategory', category: moods }]).library;
    const eras = createCategory({ name: 'Eras', entries: [{ label: 'Old', query: 'published:<1900' }] });
    const ours = { ...moods, name: 'Mood' };
    const theirs = { ...moods, entries: [] };
    for (const truth of ['ours', 'theirs'] as const) {
      const result = merge(
        start,
        [{ type: 'setCategory', category: ours }, { type: 'setCategory', category: eras }],
        [{ type: 'setCategory', category: theirs }],
        truth,
      );
      agree(result);
      expect(result.ours.categories).toEqual({ [moods.id]: truth === 'ours' ? ours : theirs, [eras.id]: eras });
      expect(result.plan.conflicts).toEqual([
        { target: ['category', moods.id, 'definition'], ours, theirs, winner: truth },
      ]);
    }
  });

  it('removes a category removed on one side', () => {
    const { library } = base();
    const moods = createCategory({ name: 'Moods', entries: [] });
    const start = applyOperations(library, [{ type: 'setCategory', category: moods }]).library;
    const result = merge(start, [], [{ type: 'removeCategory', id: moods.id }]);
    agree(result);
    expect(result.ours.categories).toEqual({});
  });

  it('takes additive changes both ways without conflicts', () => {
    const { library, dune, emma } = base();
    const x = createItem({ title: 'Piranesi' });
    const y = createItem({ title: 'Left Hand' });
    const result = merge(
      library,
      [
        { type: 'addItem', item: x },
        { type: 'addTags', id: dune.id, tags: ['Classic'] },
        { type: 'setRating', userId: LOCAL_USER, itemId: emma.id, rating: 5 },
      ],
      [
        { type: 'addItem', item: y },
        { type: 'attachFile', id: emma.id, file: file('e') },
        { type: 'setMetadata', id: dune.id, key: 'series', value: 'Dune' },
      ],
    );
    expect(result.plan.conflicts).toEqual([]);
    agree(result);
    const { items, userData } = content(result.ours);
    expect(Object.values(items).map((i) => i.title).sort()).toEqual(['Dune', 'Emma', 'Left Hand', 'Piranesi']);
    expect(items[dune.id]).toMatchObject({ tags: ['Classic', 'Fiction'], metadata: { series: 'Dune' } });
    expect(items[emma.id]!.files).toHaveLength(1);
    expect(userData[LOCAL_USER]!.ratings).toEqual({ [dune.id]: 4, [emma.id]: 5 });
  });

  it('applies edits and removals made on one side to the other', () => {
    const { library, dune, emma } = base();
    const result = merge(
      library,
      [
        { type: 'updateItem', id: dune.id, patch: { title: 'Dune (1965)' } },
        { type: 'removeTags', id: dune.id, tags: ['fiction'] },
        { type: 'detachFile', id: dune.id, hash: file('a').hash },
      ],
      [{ type: 'removeItem', id: emma.id }],
    );
    expect(result.plan.conflicts).toEqual([]);
    agree(result);
    expect(content(result.theirs).items[dune.id]).toMatchObject({ title: 'Dune (1965)', tags: [], files: [] });
    expect(result.ours.items[emma.id]).toBeUndefined();
  });

  it('settles a field both sides changed by the source of truth, and reports it', () => {
    const { library, dune } = base();
    const ours: Operation[] = [{ type: 'updateItem', id: dune.id, patch: { title: 'Dune (ours)' } }];
    const theirs: Operation[] = [
      { type: 'updateItem', id: dune.id, patch: { title: 'Dune (theirs)' } },
      { type: 'setMetadata', id: dune.id, key: 'publisher', value: 'Chilton' },
    ];
    for (const truth of ['ours', 'theirs'] as const) {
      const result = merge(library, ours, theirs, truth);
      agree(result);
      expect(result.ours.items[dune.id]!.title).toBe(`Dune (${truth})`);
      // The rest of the losing side's changes still go across.
      expect(result.ours.items[dune.id]!.metadata.publisher).toBe('Chilton');
      expect(result.plan.conflicts).toEqual([
        { target: ['item', dune.id, 'title'], ours: 'Dune (ours)', theirs: 'Dune (theirs)', winner: truth },
      ]);
    }
  });

  it('treats tags as the same ignoring case, and conflicts on a tag kept on one side and removed on the other', () => {
    const { library, dune } = base();
    const result = merge(
      library,
      [
        { type: 'addTags', id: dune.id, tags: ['Classic'] },
        { type: 'removeTags', id: dune.id, tags: ['Fiction'] },
      ],
      [
        { type: 'addTags', id: dune.id, tags: ['classic'] },
        // Removed and put back: changed, but still there.
        { type: 'removeTags', id: dune.id, tags: ['Fiction'] },
        { type: 'addTags', id: dune.id, tags: ['Fiction'] },
      ],
      'theirs',
    );
    agree(result);
    // Both added it, spelled differently: one tag, spelled as the source of truth has it.
    expect(result.plan.conflicts.map((c) => [c.target, c.ours, c.theirs])).toEqual([
      [['item', dune.id, 'tag', 'classic'], 'Classic', 'classic'],
      [['item', dune.id, 'tag', 'fiction'], undefined, 'Fiction'],
    ]);
    expect(result.ours.items[dune.id]!.tags.sort()).toEqual(['Fiction', 'classic']);
  });

  it('settles an item removed on one side and edited on the other by the source of truth', () => {
    const { library, dune, device } = base();
    const ours: Operation[] = [{ type: 'removeItem', id: dune.id }];
    const theirs: Operation[] = [
      { type: 'updateItem', id: dune.id, patch: { title: 'Dune (edited)' } },
      { type: 'setRating', userId: LOCAL_USER, itemId: dune.id, rating: 5 },
    ];

    const removed = merge(library, ours, theirs, 'ours');
    agree(removed);
    expect(removed.theirs.items[dune.id]).toBeUndefined();
    expect(removed.plan.conflicts).toEqual([{ target: ['item', dune.id], ours: false, theirs: true, winner: 'ours' }]);

    // Kept: it comes back on our side with its edits, rating and place on the device.
    const kept = merge(library, ours, theirs, 'theirs');
    agree(kept);
    expect(kept.ours.items[dune.id]).toMatchObject({ title: 'Dune (edited)', tags: ['Fiction'] });
    expect(kept.ours.userData[LOCAL_USER]!.ratings[dune.id]).toBe(5);
    expect(kept.ours.devices![device.id]!.items).toEqual([dune.id]);
  });

  it('keeps the newer reading position whichever side is the source of truth, without calling it a conflict', () => {
    const { library, dune } = base();
    const position = (locator: string): Operation => ({
      type: 'setPosition',
      userId: LOCAL_USER,
      itemId: dune.id,
      position: { hash: file('a').hash, locator },
    });
    const result = merge(library, [position('chapter 2')], [position('chapter 9')], 'ours', {
      ours: '2026-01-01T00:00:00.000Z',
      theirs: '2026-01-05T00:00:00.000Z',
    });
    agree(result);
    expect(result.plan.conflicts).toEqual([]);
    expect(result.ours.userData[LOCAL_USER]!.positions![dune.id]!.locator).toBe('chapter 9');
  });

  it('merges device changes setting by setting, and settles a device removed on one side and used on the other', () => {
    const { library, device, emma } = base();
    const result = merge(
      library,
      [
        { type: 'updateDevice', id: device.id, patch: { settings: { address: 'http://x4.local' } } },
        { type: 'updateDevice', id: device.id, patch: { name: 'Reader' } },
      ],
      [
        { type: 'updateDevice', id: device.id, patch: { settings: { folder: '/Library' } } },
        { type: 'updateDevice', id: device.id, patch: { name: 'X4 Pro' } },
        { type: 'addDeviceItems', id: device.id, itemIds: [emma.id] },
      ],
    );
    agree(result);
    expect(result.ours.devices![device.id]).toMatchObject({
      name: 'Reader',
      settings: { address: 'http://x4.local', folder: '/Library' },
    });
    expect(result.plan.conflicts.map((c) => c.target)).toEqual([['device', device.id, 'name']]);

    const removed = merge(library, [{ type: 'removeDevice', id: device.id }], [{ type: 'addDeviceItems', id: device.id, itemIds: [emma.id] }], 'theirs');
    agree(removed);
    expect(removed.ours.devices![device.id]!.items.sort()).toEqual(
      [content(library).devices[device.id]!.items[0]!, emma.id].sort(),
    );
  });

  it('brings a new device across whole, with its items once they exist', () => {
    const { library, dune } = base();
    const piranesi = createItem({ title: 'Piranesi' });
    const kobo = createDevice({ name: 'Kobo', type: 'kobo' });
    const result = merge(
      library,
      [
        { type: 'addItem', item: piranesi },
        { type: 'addDevice', device: kobo },
        { type: 'addDeviceItems', id: kobo.id, itemIds: [dune.id, piranesi.id] },
      ],
      [],
    );
    agree(result);
    expect(result.theirs.devices![kobo.id]!.items.sort()).toEqual([dune.id, piranesi.id].sort());
  });

  it('settles the same file attached with different details on each side', () => {
    const { library, emma } = base();
    const named = (name: string) => ({ ...file('e'), name });
    const result = merge(
      library,
      [{ type: 'attachFile', id: emma.id, file: named('Emma.epub') }],
      [{ type: 'attachFile', id: emma.id, file: named('emma (1).epub') }],
      'theirs',
    );
    agree(result);
    expect(result.plan.conflicts).toHaveLength(1);
    expect(result.ours.items[emma.id]!.files.map((f) => f.name)).toEqual(['emma (1).epub']);
  });

  it('does nothing when neither side changed anything, or both made the same change', () => {
    const { library, dune } = base();
    expect(planMerge({ library, changes: [] }, { library, changes: [] }, 'ours')).toEqual({ ours: [], theirs: [], conflicts: [] });
    const same: Operation[] = [{ type: 'updateItem', id: dune.id, patch: { title: 'Dune (1965)' } }];
    const result = merge(library, same, same);
    expect(result.plan).toEqual({ ours: [], theirs: [], conflicts: [] });
  });
});

/** A small seeded generator, so a failure can be replayed. */
const random = (seed: number) => () => {
  seed = (seed * 1103515245 + 12345) % 2 ** 31;
  return seed / 2 ** 31;
};

/** Up to `count` random valid operations on `library`, applied as they're made. */
function edits(library: Library, count: number, next: () => number): Operation[] {
  const pick = <T,>(values: T[]): T | undefined => values[Math.floor(next() * values.length)];
  const ops: Operation[] = [];
  for (let i = 0; i < count; i++) {
    const items = Object.values(library.items);
    const devices = Object.values(library.devices ?? {});
    const item = pick(items);
    const device = pick(devices);
    const category = pick(Object.values(library.categories ?? {}));
    const choices: (() => Operation | undefined)[] = [
      () => ({ type: 'addItem', item: createItem({ title: `New ${Math.floor(next() * 1000)}`, tags: [pick(['A', 'b'])!] }) }),
      () => item && { type: 'updateItem', id: item.id, patch: { title: `T${Math.floor(next() * 3)}` } },
      () => item && { type: 'setMetadata', id: item.id, key: pick(['series', 'pages'])!, value: pick(['x', 'y', undefined]) },
      () => item && { type: 'addTags', id: item.id, tags: [pick(['A', 'a', 'B', 'c'])!] },
      () => item && { type: 'removeTags', id: item.id, tags: [pick(['a', 'b', 'c', 'fiction'])!] },
      () => item && { type: 'attachFile', id: item.id, file: file(pick(['a', 'b', 'c'])!) },
      () => item && { type: 'detachFile', id: item.id, hash: file(pick(['a', 'b', 'c'])!).hash },
      () => item && next() < 0.3 ? { type: 'removeItem', id: item.id } : undefined,
      () => item && { type: 'setRating', userId: LOCAL_USER, itemId: item.id, rating: pick([1, 3, 5, undefined]) },
      () => item && { type: 'setReview', userId: LOCAL_USER, itemId: item.id, text: pick(['Good', 'Meh', undefined]) },
      () => item && { type: 'setPosition', userId: LOCAL_USER, itemId: item.id, position: { hash: file('a').hash, locator: pick(['1', '2'])! } },
      () => ({ type: 'addDevice', device: createDevice({ name: 'D', type: 'kobo' }) }),
      () => device && { type: 'updateDevice', id: device.id, patch: { name: pick(['P', 'Q']), settings: { [pick(['address', 'folder'])!]: pick(['1', '2', undefined]) } } },
      () => device && item && { type: 'addDeviceItems', id: device.id, itemIds: [item.id] },
      () => device && item && { type: 'removeDeviceItems', id: device.id, itemIds: [item.id] },
      () => device && next() < 0.3 ? { type: 'removeDevice', id: device.id } : undefined,
      () => device && { type: 'recordDeviceSync', id: device.id, placed: { [`/b/${pick(['1', '2'])}`]: { itemId: 'x', hash: file('a').hash, size: 1, key: 'k' } }, removed: [] },
      () => ({ type: 'setCategory', category: createCategory({ name: pick(['M', 'N'])!, entries: [{ label: 'E', query: 'tag:a' }] }) }),
      () => category && { type: 'setCategory', category: { ...category, name: pick(['M', 'N', 'O'])! } },
      () => category && next() < 0.3 ? { type: 'removeCategory', id: category.id } : undefined,
    ];
    const op = pick(choices)!();
    if (!op) continue;
    library = applyOperations(library, [op]).library;
    ops.push(op);
  }
  return ops;
}

describe('planMerge on random edits', () => {
  // Raising these (to 5000 seeds and up to 30 edits a side) is a longer search; it passed on 2026-10-01, as did the
  // same for the repair test below.
  it('always ends with both sides the same, and nothing left to do', () => {
    for (let seed = 1; seed <= 300; seed++) {
      const next = random(seed);
      const { library } = base();
      const ours = edits(library, 1 + Math.floor(next() * 12), next);
      const theirs = edits(library, 1 + Math.floor(next() * 12), next);
      const truth = next() < 0.5 ? 'ours' : 'theirs';
      try {
        agree(merge(library, ours, theirs, truth));
      } catch (e) {
        throw new Error(`seed ${seed}: ${e instanceof Error ? e.message : e}\nours: ${JSON.stringify(ours)}\ntheirs: ${JSON.stringify(theirs)}`, { cause: e });
      }
    }
  });
});

describe('stateDigest', () => {
  it('ignores what is local to an instance or to when things were applied', () => {
    const { library, dune, device } = base();
    // The same edits on another instance, applied later and in another order.
    const edits: Operation[] = [
      { type: 'addTags', id: dune.id, tags: ['Classic'] },
      { type: 'setReview', userId: LOCAL_USER, itemId: dune.id, text: 'Spice' },
      { type: 'setPosition', userId: LOCAL_USER, itemId: dune.id, position: { hash: file('a').hash, locator: '5' } },
      { type: 'recordDeviceSync', id: device.id, placed: {}, removed: [] },
    ];
    const a = applyOperations(library, edits, '2026-01-01T00:00:00.000Z').library;
    const b = applyOperations({ ...library, origin: 'other' }, [...edits].reverse(), '2026-03-01T00:00:00.000Z').library;
    expect(a.items[dune.id]!.updatedAt).not.toBe(b.items[dune.id]!.updatedAt);
    expect(stateDigest(a)).toEqual(stateDigest(b));
  });

  it('tells which items and devices differ', () => {
    const { library, dune, emma, device } = base();
    const piranesi = createItem({ title: 'Piranesi' });
    const changed = applyOperations(library, [
      { type: 'setMetadata', id: dune.id, key: 'series', value: 'Dune' },
      { type: 'setRating', userId: LOCAL_USER, itemId: emma.id, rating: 2 },
      { type: 'addItem', item: piranesi },
      { type: 'updateDevice', id: device.id, patch: { settings: { folder: '/books' } } },
    ]).library;
    const a = stateDigest(library);
    const b = stateDigest(changed);
    expect(a.hash).not.toBe(b.hash);
    expect(differingParts(a, b)).toEqual(
      [`device:${device.id}`, `item:${dune.id}`, `item:${emma.id}`, `item:${piranesi.id}`].sort(),
    );
  });
});

describe('planRepair', () => {
  /** Repairs `dest` from `source`, checks they then agree, and that a second repair has nothing to do. */
  function repair(source: Library, dest: Library) {
    const plan = planRepair(source, dest);
    const repaired = applyOperations(dest, plan.operations).library;
    expect(content(repaired)).toEqual(content(source));
    expect(stateDigest(repaired).hash).toBe(stateDigest(source).hash);
    expect(planRepair(source, repaired)).toEqual({ parts: [], operations: [] });
    return { plan, repaired };
  }

  it('does nothing when the libraries agree', () => {
    const { library } = base();
    expect(planRepair(library, { ...library, origin: 'other', revision: 99 })).toEqual({ parts: [], operations: [] });
  });

  it('copies what differs from the source of truth, part by part', () => {
    const { library, dune, emma, device } = base();
    const piranesi = createItem({ title: 'Piranesi', tags: ['Fantasy'] });
    const kobo = createDevice({ name: 'Kobo', type: 'kobo' });
    const source = applyOperations(library, [
      { type: 'updateItem', id: dune.id, patch: { title: 'Dune (1965)' } },
      { type: 'removeTags', id: dune.id, tags: ['fiction'] },
      { type: 'addTags', id: dune.id, tags: ['SF'] },
      { type: 'setPosition', userId: LOCAL_USER, itemId: dune.id, position: { hash: file('a').hash, locator: '9' } },
      { type: 'addItem', item: piranesi },
      { type: 'setReview', userId: LOCAL_USER, itemId: piranesi.id, text: 'Halls' },
      { type: 'addDeviceItems', id: device.id, itemIds: [piranesi.id] },
      { type: 'addDevice', device: kobo },
      { type: 'addDeviceItems', id: kobo.id, itemIds: [dune.id, piranesi.id] },
      { type: 'recordDeviceSync', id: device.id, placed: { '/a.epub': { itemId: dune.id, hash: file('a').hash, size: 1 } }, removed: [] },
    ]).library;
    const dest = applyOperations(library, [
      { type: 'addTags', id: dune.id, tags: ['sf'] },
      { type: 'attachFile', id: dune.id, file: file('b') },
      { type: 'setRating', userId: LOCAL_USER, itemId: dune.id, rating: 1 },
      { type: 'removeItem', id: emma.id },
      { type: 'updateDevice', id: device.id, patch: { name: 'Old X4', settings: { address: undefined } } },
    ]).library;
    const { plan } = repair(source, dest);
    expect(plan.parts).toEqual(
      [`item:${dune.id}`, `item:${emma.id}`, `item:${piranesi.id}`, `device:${device.id}`, `device:${kobo.id}`].sort(),
    );
  });

  it('removes what only the library being repaired has', () => {
    const { library, dune, device } = base();
    const source = applyOperations(library, [
      { type: 'removeItem', id: dune.id },
      { type: 'removeDevice', id: device.id },
    ]).library;
    repair(source, library);
  });

  it('repairs libraries edited apart in any way', () => {
    for (let seed = 1; seed <= 200; seed++) {
      const next = random(seed);
      const { library } = base();
      const a = applyOperations(library, edits(library, 1 + Math.floor(next() * 12), next)).library;
      const b = applyOperations({ ...library, origin: 'b' }, edits(library, 1 + Math.floor(next() * 12), next)).library;
      try {
        repair(a, b);
      } catch (e) {
        throw new Error(`seed ${seed}: ${e instanceof Error ? e.message : e}`, { cause: e });
      }
    }
  });
});
