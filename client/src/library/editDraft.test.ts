import { applyOperations, createItem, createLibrary, LOCAL_USER } from '@nexlibris/common';
import { describe, expect, it } from 'vitest';
import { diffDraft, draftFromItem } from './editDraft';

const item = createItem({
  title: 'Dune',
  creators: [{ name: 'Frank Herbert', role: 'aut' }],
  tags: ['Sci-Fi', 'Desert'],
  identifiers: { isbn: '9780441013593' },
  metadata: { series: 'Dune', seriesIndex: 1, description: 'Spice.' },
});

describe('diffDraft', () => {
  it('produces nothing for an unchanged draft', () => {
    expect(diffDraft(item, 'Great', draftFromItem(item, 'Great'))).toEqual([]);
  });

  it('turns edits into fine-grained operations', () => {
    const draft = draftFromItem(item, undefined);
    draft.title = ' Dune Messiah ';
    draft.tags = ['sci-fi', 'Sequel'];
    draft.fields = { ...draft.fields, seriesIndex: '2', originallyPublished: '1969' };
    draft.metadata = [['mood', 'sandy']];
    draft.description = '';
    draft.review = 'Better than expected';

    expect(diffDraft(item, undefined, draft)).toEqual([
      { type: 'updateItem', id: item.id, patch: { title: 'Dune Messiah' } },
      { type: 'addTags', id: item.id, tags: ['Sequel'] },
      { type: 'removeTags', id: item.id, tags: ['Desert'] },
      { type: 'setMetadata', id: item.id, key: 'mood', value: 'sandy' },
      { type: 'setMetadata', id: item.id, key: 'seriesIndex', value: 2 },
      { type: 'setMetadata', id: item.id, key: 'originallyPublished', value: '1969' },
      { type: 'setMetadata', id: item.id, key: 'description', value: undefined },
      { type: 'setReview', userId: LOCAL_USER, itemId: item.id, text: 'Better than expected' },
    ]);
  });

  it('shows dates before AD 1 with their era, and takes them as typed', () => {
    const sappho = createItem({ title: 'Lyrics', metadata: { originallyPublished: '-0570', published: '0008' } });
    const draft = draftFromItem(sappho, undefined);
    expect(draft.fields).toMatchObject({ originallyPublished: '570 BC', published: 'AD 8' });
    expect(diffDraft(sappho, undefined, draft)).toEqual([]);
    draft.fields = { ...draft.fields, originallyPublished: 'c. 600 BCE' };
    expect(diffDraft(sappho, undefined, draft)).toEqual([{ type: 'setMetadata', id: sappho.id, key: 'originallyPublished', value: '-0600' }]);
  });

  it('drops blank creators and identifiers, and applies cleanly', () => {
    const draft = draftFromItem(item, undefined);
    draft.creators = [...draft.creators, { name: '  ', role: 'aut' }, { name: 'Brian Herbert', role: 'edt' }];
    draft.identifiers = [...draft.identifiers, ['asin', ''], ['goodreads', '234225']];
    const ops = diffDraft(item, undefined, draft);
    const { library } = applyOperations(createLibrary('t'), [{ type: 'addItem', item }, ...ops]);
    expect(library.items[item.id]).toMatchObject({
      creators: [
        { name: 'Frank Herbert', role: 'aut' },
        { name: 'Brian Herbert', role: 'edt' },
      ],
      identifiers: { isbn: '9780441013593', goodreads: '234225' },
    });
  });
});
