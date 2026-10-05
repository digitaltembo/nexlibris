import { LOCAL_USER, normalizeValue, type Creator, type FileRef, type Item, type Operation, type UserId } from '@nexlibris/common';
import { BOOK_FIELDS, fieldText, isFixedField } from './bookFields';
import { metadataToText, textToMetadata } from './metadataText';

/** An item's editable fields as plain form state, until the user saves. */
export interface ItemDraft {
  title: string;
  creators: Creator[];
  tags: string[];
  review: string;
  /** Edited separately from other metadata since it's usually long. */
  description: string;
  /** `BookMetadata`'s fixed fields, as text (empty for none). */
  fields: Record<string, string>;
  /** Custom fields. */
  metadata: [key: string, text: string][];
  identifiers: [scheme: string, value: string][];
  /** Detaching happens on save, like any other edit. */
  files: FileRef[];
}

export function draftFromItem(item: Item, review: string | undefined): ItemDraft {
  const description = item.metadata.description;
  return {
    title: item.title,
    creators: item.creators,
    tags: item.tags,
    review: review ?? '',
    description: typeof description === 'string' ? description : '',
    fields: Object.fromEntries(BOOK_FIELDS.map((f) => [f.key, fieldText(f.key, item.metadata[f.key])])),
    metadata: Object.entries(item.metadata)
      .filter(([key]) => !isFixedField(key) && (key !== 'description' || typeof description !== 'string'))
      .map(([key, value]) => [key, metadataToText(value)]),
    identifiers: Object.entries(item.identifiers),
    files: item.files,
  };
}

const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const tagKey = (tag: string) => tag.trim().toLowerCase();

/** The operations that turn `item` (and its review) into what the draft describes. */
export function diffDraft(
  item: Item,
  review: string | undefined,
  draft: ItemDraft,
  userId: UserId = LOCAL_USER,
): Operation[] {
  const ops: Operation[] = [];
  const id = item.id;

  const patch: Extract<Operation, { type: 'updateItem' }>['patch'] = {};
  const title = draft.title.trim();
  if (title && title !== item.title) patch.title = title;
  const creators = draft.creators
    .map((c) => ({ ...c, name: c.name.trim() }))
    .filter((c) => c.name);
  if (!sameJson(creators, item.creators)) patch.creators = creators;
  const identifiers = Object.fromEntries(
    draft.identifiers.map(([k, v]) => [k.trim(), v.trim()] as const).filter(([k, v]) => k && v),
  );
  if (!sameJson(identifiers, item.identifiers)) patch.identifiers = identifiers;
  if (Object.keys(patch).length) ops.push({ type: 'updateItem', id, patch });

  const current = new Set(item.tags.map(tagKey));
  const wanted = new Set(draft.tags.map(tagKey));
  const added = draft.tags.filter((t) => !current.has(tagKey(t)));
  const removed = item.tags.filter((t) => !wanted.has(tagKey(t)));
  if (added.length) ops.push({ type: 'addTags', id, tags: added });
  if (removed.length) ops.push({ type: 'removeTags', id, tags: removed });

  const metadata = new Map<string, string>(draft.metadata.map(([k, v]) => [k.trim(), v] as const).filter(([k]) => k));
  for (const [key, text] of Object.entries(draft.fields)) if (text.trim()) metadata.set(key, text.trim());
  if (draft.description.trim()) metadata.set('description', draft.description.trim());
  for (const [key, text] of metadata) {
    // As it would be stored, so a date left as shown ("570 BC" for -0570) isn't a change.
    const value = normalizeValue(key, textToMetadata(text, item.metadata[key])) ?? text;
    if (!sameJson(value, item.metadata[key])) ops.push({ type: 'setMetadata', id, key, value });
  }
  for (const key of Object.keys(item.metadata)) {
    if (!metadata.has(key)) ops.push({ type: 'setMetadata', id, key, value: undefined });
  }

  const kept = new Set(draft.files.map((f) => f.hash));
  for (const file of item.files) {
    if (!kept.has(file.hash)) ops.push({ type: 'detachFile', id, hash: file.hash });
  }

  const newReview = draft.review.trim();
  if (newReview !== (review ?? '')) {
    ops.push({ type: 'setReview', userId, itemId: id, text: newReview || undefined });
  }
  return ops;
}
