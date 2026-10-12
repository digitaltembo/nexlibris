import { applyOperations, createItem, createLibrary, LOCAL_USER, type Item, type Library } from '@nexlibris/common';
import { describe, expect, it } from 'vitest';
import { currentlyReading, setAsideOperations } from './currentlyReading';

const book = (title: string): Item => createItem({ title, files: [{ hash: `h-${title}`, format: 'epub', size: 1 }] });
const emma = book('Emma');
const dune = book('Dune');
const done = book('Done');
const gone = book('Gone');

function reading(): Library {
  const library = { ...createLibrary('Mine'), items: Object.fromEntries([emma, dune, done, gone].map((i) => [i.id, i])) };
  const at = (item: Item, progress: number, hash = item.files[0]!.hash) => ({ type: 'setPosition' as const, userId: LOCAL_USER, itemId: item.id, position: { hash, locator: `loc-${item.title}`, progress } });
  let next = library as Library;
  for (const op of [at(emma, 0.2), at(done, 1), at(gone, 0.5, 'a file since removed'), at(dune, 0.6)]) {
    next = applyOperations(next, [op]).library;
  }
  return next;
}

describe('Currently Reading', () => {
  it('lists the books being read, latest first, leaving out finished ones and places in files that have gone', () => {
    const library = reading();
    // Positions saved in the same millisecond keep the order they were saved in only by chance; set them apart.
    library.userData[LOCAL_USER]!.positions![emma.id]!.updatedAt = '2026-10-01T00:00:00.000Z';
    library.userData[LOCAL_USER]!.positions![dune.id]!.updatedAt = '2026-10-02T00:00:00.000Z';
    const found = currentlyReading(library);
    expect(found.map((r) => r.item.title)).toEqual(['Dune', 'Emma']);
    expect(found[0]).toMatchObject({ file: dune.files[0], position: { locator: 'loc-Dune', progress: 0.6 } });
  });

  it('takes a book out, keeping its place; reading it again brings it back', () => {
    const library = reading();
    const [first] = currentlyReading(library).filter((r) => r.item.id === emma.id);
    const aside = applyOperations(library, setAsideOperations(first!)).library;
    expect(currentlyReading(aside).map((r) => r.item.title)).not.toContain('Emma');
    expect(aside.userData[LOCAL_USER]!.positions![emma.id]).toMatchObject({ locator: 'loc-Emma', progress: 0.2, setAside: true });
    const again = applyOperations(aside, [
      { type: 'setPosition', userId: LOCAL_USER, itemId: emma.id, position: { hash: emma.files[0]!.hash, locator: 'loc-later', progress: 0.25 } },
    ]).library;
    expect(currentlyReading(again).map((r) => r.item.title)).toContain('Emma');
  });
});
