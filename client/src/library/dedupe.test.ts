import { applyOperations, createDevice, createItem, createLibrary, LOCAL_USER, userData, type Library, type Operation } from '@nexlibris/common';
import { describe, expect, it } from 'vitest';
import { findDuplicates, mergeItems } from './dedupe';

const author = (name: string) => [{ name, role: 'aut' }];
const epub = { hash: 'a'.repeat(64), size: 1, format: 'epub' };
const mobi = { hash: 'b'.repeat(64), size: 1, format: 'mobi' };
const pdf = { hash: 'c'.repeat(64), size: 1, format: 'pdf' };

const build = (ops: Operation[]) => applyOperations(createLibrary('Test'), ops).library;

describe('findDuplicates', () => {
  it('groups items with the same title and authors, loosely, best to keep first', () => {
    const dune = createItem({ title: 'Dune', creators: author('Frank Herbert'), files: [epub] }, '2026-01-02T00:00:00Z');
    const duneAgain = createItem({ title: 'DUNE!', creators: author('Frank  Herbert'), files: [epub, mobi] }, '2026-01-03T00:00:00Z');
    const duneOlder = createItem({ title: 'dune', creators: author('Frank Herbert') }, '2026-01-01T00:00:00Z');
    const otherDune = createItem({ title: 'Dune', creators: author('Someone Else') });
    const untitledA = createItem({ title: '', creators: author('Frank Herbert') });
    const untitledB = createItem({ title: '', creators: author('Frank Herbert') });
    const anonA = createItem({ title: 'Beowulf' });
    const anonB = createItem({ title: 'Beowulf' });
    const library = build([dune, duneAgain, duneOlder, otherDune, untitledA, untitledB, anonA, anonB].map((item) => ({ type: 'addItem', item })));

    const groups = findDuplicates(library);
    expect(groups.map((g) => g.items.map((i) => i.id))).toEqual([[duneAgain.id, dune.id, duneOlder.id]]);
  });

  it('matches the same authors in any order', () => {
    const a = createItem({ title: 'Good Omens', creators: [...author('Terry Pratchett'), ...author('Neil Gaiman')] });
    const b = createItem({ title: 'Good Omens', creators: [...author('Neil Gaiman'), ...author('Terry Pratchett')] });
    const c = createItem({ title: 'Good Omens', creators: author('Neil Gaiman') });
    const library = build([a, b, c].map((item) => ({ type: 'addItem', item })));
    expect(findDuplicates(library).map((g) => g.items.length)).toEqual([2]);
  });
});

describe('mergeItems', () => {
  const setup = () => {
    const keep = createItem({ title: 'Dune', creators: author('Frank Herbert'), files: [epub], tags: ['SF'], metadata: { series: 'Dune' }, identifiers: { isbn: '9780441013593' } });
    const other = createItem({
      title: 'Dune',
      creators: author('Frank Herbert'),
      files: [epub, mobi],
      tags: ['sf', 'Classic'],
      metadata: { series: 'Other', publisher: 'Ace' },
      identifiers: { isbn: '0000000000', uuid: 'u-1' },
      cover: { hash: 'd'.repeat(64), mediaType: 'image/jpeg' },
    });
    const third = createItem({ title: 'Dune', creators: author('Frank Herbert'), files: [pdf] });
    const device = createDevice({ name: 'X4', type: 'crosspoint.x4' });
    const library = build([
      { type: 'addItem', item: keep },
      { type: 'addItem', item: other },
      { type: 'addItem', item: third },
      { type: 'addDevice', device },
      { type: 'addDeviceItems', id: device.id, itemIds: [other.id] },
      { type: 'setRating', userId: LOCAL_USER, itemId: other.id, rating: 4 },
      { type: 'setRating', userId: LOCAL_USER, itemId: third.id, rating: 2 },
      { type: 'setReview', userId: LOCAL_USER, itemId: third.id, text: 'Spice.' },
      { type: 'setPosition', userId: LOCAL_USER, itemId: other.id, position: { hash: mobi.hash, locator: '12' } },
    ]);
    return { library, keep, other, third, device };
  };

  it("moves what the others have that the kept item lacks, keeping the kept item's own, then removes them", () => {
    const { library, keep, other, third, device } = setup();
    const merged: Library = applyOperations(library, mergeItems(library, keep.id, [other.id, third.id])).library;

    expect(Object.keys(merged.items)).toEqual([keep.id]);
    const item = merged.items[keep.id]!;
    expect(item.files.map((f) => f.format)).toEqual(['epub', 'mobi', 'pdf']);
    expect(item.tags).toEqual(['SF', 'Classic']);
    expect(item.metadata).toEqual({ series: 'Dune', publisher: 'Ace' });
    expect(item.identifiers).toEqual({ isbn: '9780441013593', uuid: 'u-1' });
    expect(item.cover).toEqual(other.cover);
    const data = userData(merged);
    // The first rating found wins; the review comes from whichever has one.
    expect(data.ratings).toEqual({ [keep.id]: 4 });
    expect(data.reviews[keep.id]?.text).toBe('Spice.');
    expect(data.positions?.[keep.id]).toMatchObject({ hash: mobi.hash, locator: '12' });
    expect(merged.devices?.[device.id]?.items).toEqual([keep.id]);
  });

  it("doesn't touch the kept item's own rating, or merge it into itself", () => {
    const { library, keep, other } = setup();
    const rated = applyOperations(library, [{ type: 'setRating', userId: LOCAL_USER, itemId: keep.id, rating: 5 }]).library;
    const ops = mergeItems(rated, keep.id, [keep.id, other.id]);
    expect(ops.filter((op) => op.type === 'setRating')).toEqual([]);
    expect(ops.filter((op) => op.type === 'removeItem')).toEqual([{ type: 'removeItem', id: other.id }]);
  });
});
