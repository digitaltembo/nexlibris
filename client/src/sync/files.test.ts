import { createItem, LOCAL_USER, MemoryStorage, StoredLibraryBackend } from '@nexlibris/common';
import { describe, expect, it } from 'vitest';
import { keepRule } from './files';

describe('keepRule', () => {
  it('keeps every book without a search, else those matching it (ratings included)', async () => {
    const reading = createItem({ title: 'Reading', tags: ['reading'] });
    const loved = createItem({ title: 'Loved' });
    const other = createItem({ title: 'Other' });
    const library = await new StoredLibraryBackend(new MemoryStorage()).apply([
      ...[reading, loved, other].map((item) => ({ type: 'addItem' as const, item })),
      { type: 'setRating', userId: LOCAL_USER, itemId: loved.id, rating: 5 },
    ]);
    expect(keepRule(undefined, library)).toBeUndefined();
    expect(keepRule('  ', library)).toBeUndefined();
    const keep = keepRule('tag:reading or rating:5', library)!;
    expect([reading, loved, other].map(keep)).toEqual([true, true, false]);
  });
});
