import type { Item, ItemId, Library, Operation } from '@nexlibris/common';
import { loose } from './importFiles';
import { t } from '../i18n';

/**
 * Library cleanup's duplicates: items with the same title and authors, compared loosely (case,
 * accents and punctuation aside), as an import matches books. Merging one into another moves
 * what it has that the other lacks, then removes it.
 */

export interface DuplicateGroup {
  /** The loose title and authors they share. */
  key: string;
  /** Best to keep first: the most files, then the most filled in, then the earliest added. */
  items: Item[];
}

const authorsOf = (item: Item) => [...new Set(item.creators.map((c) => loose(c.name)).filter(Boolean))].sort();

/** How much an item has, to choose which of a group to keep. */
const richness = (item: Item) =>
  Object.keys(item.metadata).length + Object.keys(item.identifiers).length + item.tags.length + (item.cover ? 1 : 0);

/** Items sharing a title and authors, groups in title order. Items without a title or an author aren't compared. */
export function findDuplicates(library: Library): DuplicateGroup[] {
  const groups = new Map<string, Item[]>();
  for (const item of Object.values(library.items)) {
    const title = loose(item.title);
    const authors = authorsOf(item);
    if (!title || !authors.length) continue;
    const key = `${title}\n${authors.join('\n')}`;
    groups.set(key, [...(groups.get(key) ?? []), item]);
  }
  return [...groups]
    .filter(([, items]) => items.length > 1)
    .map(([key, items]) => ({
      key,
      items: items.sort(
        (a, b) => b.files.length - a.files.length || richness(b) - richness(a) || a.addedAt.localeCompare(b.addedAt),
      ),
    }))
    .sort((a, b) => a.items[0]!.title.localeCompare(b.items[0]!.title) || a.key.localeCompare(b.key));
}

/**
 * The operations merging `merged` into `keep`: their files, tags, cover, and fields and
 * identifiers `keep` doesn't have; each user's rating, review and reading position where `keep`
 * has none; their places on devices. Then they're removed. What `keep` has always stays.
 */
export function mergeItems(library: Library, keep: ItemId, merged: ItemId[]): Operation[] {
  const kept = library.items[keep];
  if (!kept) throw new Error(t('errors.keptGone'));
  const ops: Operation[] = [];
  const hashes = new Set(kept.files.map((f) => f.hash));
  const tags = new Set(kept.tags.map((t) => t.toLowerCase()));
  const newTags: string[] = [];
  const fields = new Set(Object.keys(kept.metadata));
  let identifiers = kept.identifiers;
  let cover = kept.cover;
  const users = Object.entries(library.userData).map(([userId, data]) => ({
    userId,
    data,
    rated: kept.id in data.ratings,
    reviewed: kept.id in data.reviews,
    placed: !!data.positions?.[kept.id],
  }));
  const devices = Object.values(library.devices ?? {}).map((device) => ({ device, has: device.items.includes(kept.id) }));

  for (const id of merged) {
    const item = library.items[id];
    if (!item || id === keep) continue;
    for (const file of item.files) {
      if (hashes.has(file.hash)) continue;
      hashes.add(file.hash);
      ops.push({ type: 'attachFile', id: keep, file });
    }
    for (const tag of item.tags) {
      if (tags.has(tag.toLowerCase())) continue;
      tags.add(tag.toLowerCase());
      newTags.push(tag);
    }
    for (const [key, value] of Object.entries(item.metadata)) {
      if (fields.has(key)) continue;
      fields.add(key);
      ops.push({ type: 'setMetadata', id: keep, key, value });
    }
    identifiers = { ...item.identifiers, ...identifiers };
    cover ??= item.cover;
    for (const user of users) {
      const { userId, data } = user;
      const rating = data.ratings[id];
      if (!user.rated && rating !== undefined) {
        user.rated = true;
        ops.push({ type: 'setRating', userId, itemId: keep, rating });
      }
      const review = data.reviews[id];
      if (!user.reviewed && review) {
        user.reviewed = true;
        ops.push({ type: 'setReview', userId, itemId: keep, text: review.text });
      }
      const position = data.positions?.[id];
      if (!user.placed && position) {
        user.placed = true;
        const { updatedAt: _updatedAt, ...rest } = position;
        ops.push({ type: 'setPosition', userId, itemId: keep, position: rest });
      }
    }
    for (const entry of devices) {
      if (entry.has || !entry.device.items.includes(id)) continue;
      entry.has = true;
      ops.push({ type: 'addDeviceItems', id: entry.device.id, itemIds: [keep] });
    }
  }

  if (newTags.length) ops.push({ type: 'addTags', id: keep, tags: newTags });
  const patch = {
    ...(Object.keys(identifiers).length !== Object.keys(kept.identifiers).length && { identifiers }),
    ...(cover !== kept.cover && { cover }),
  };
  if (Object.keys(patch).length) ops.push({ type: 'updateItem', id: keep, patch });
  for (const id of merged) if (id !== keep && library.items[id]) ops.push({ type: 'removeItem', id });
  return ops;
}
