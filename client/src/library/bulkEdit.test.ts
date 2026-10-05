import { createItem } from '@nexlibris/common';
import { describe, expect, it } from 'vitest';
import { addCreatorOps, parseTags, removeCreatorOps, removeTagsOps } from './bulkEdit';

const dune = createItem({ title: 'Dune', tags: ['Fiction', 'sf'], creators: [{ name: 'Frank Herbert', role: 'aut' }, { name: 'John Schoenherr', role: 'ill' }] });
const emma = createItem({ title: 'Emma', tags: ['fiction'], creators: [{ name: 'Jane Austen', role: 'aut' }] });
const notes = createItem({ title: 'Notes', creators: [{ name: 'John Schoenherr', role: 'aut' }] });

describe('bulk edits', () => {
  it('removes typed tags from the items that have them, whatever their case', () => {
    expect(parseTags(' sf,, fiction ,')).toEqual(['sf', 'fiction']);
    expect(removeTagsOps([dune, emma, notes], ['FICTION '])).toEqual([
      { type: 'removeTags', id: dune.id, tags: ['FICTION '] },
      { type: 'removeTags', id: emma.id, tags: ['FICTION '] },
    ]);
    expect(removeTagsOps([emma, notes], ['sf'])).toEqual([]);
  });

  it('removes a creator in any role from the items that have them, and adds one only where missing', () => {
    expect(removeCreatorOps([dune, emma, notes], 'john schoenherr')).toEqual([
      { type: 'updateItem', id: dune.id, patch: { creators: [{ name: 'Frank Herbert', role: 'aut' }] } },
      { type: 'updateItem', id: notes.id, patch: { creators: [] } },
    ]);
    expect(addCreatorOps([dune, emma], ' Frank Herbert ')).toEqual([
      { type: 'updateItem', id: emma.id, patch: { creators: [{ name: 'Jane Austen', role: 'aut' }, { name: 'Frank Herbert', role: 'aut' }] } },
    ]);
  });
});
