import type { Item, Operation } from '@nexlibris/common';

/**
 * Bulk edits to tags and creators, as operations on just the items they change. Names match
 * whatever their case and surrounding spaces, as tags do in the library.
 */

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/** Tags typed as a list: `fantasy, "to read"` (comma-separated, blanks dropped). */
export const parseTags = (text: string) => text.split(',').map((t) => t.trim()).filter(Boolean);

/** Takes `tags` off every item that has any of them. */
export function removeTagsOps(items: Item[], tags: string[]): Operation[] {
  return items
    .filter((item) => item.tags.some((t) => tags.some((tag) => same(t, tag))))
    .map((item) => ({ type: 'removeTags', id: item.id, tags }));
}

/** Adds an author to every item that doesn't already have that creator. */
export function addCreatorOps(items: Item[], name: string): Operation[] {
  return items
    .filter((item) => !item.creators.some((c) => same(c.name, name)))
    .map((item) => ({ type: 'updateItem', id: item.id, patch: { creators: [...item.creators, { name: name.trim(), role: 'aut' }] } }));
}

/** Takes the creator named `name` (in any role) off every item that has them. */
export function removeCreatorOps(items: Item[], name: string): Operation[] {
  return items
    .filter((item) => item.creators.some((c) => same(c.name, name)))
    .map((item) => ({ type: 'updateItem', id: item.id, patch: { creators: item.creators.filter((c) => !same(c.name, name)) } }));
}
