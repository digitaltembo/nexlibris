import type { Operation } from './operations';
import type { Device, Item, ItemId, Library, UserData } from './types';

/**
 * What a hub shows an instance that syncs with it (M6): only the books that instance keeps, by
 * the rules of its connection in the hub's library (the connection whose id is its origin), plus
 * any it already has, so edits to them still merge. Everything else that names an item (ratings,
 * reviews, positions, devices' items and placed files) is cut down to those books, and so are the
 * changes the hub sends, so an instance never sees the details of a book it doesn't keep.
 *
 * Which items a connection's rules pick is up to the client (`library/search.ts`), so the hub's
 * host passes it in as a {@link ScopeRule}.
 */

/**
 * The items an instance keeps, by its connection in `library`, or by `keeps` (its own connection's
 * rules, as it sent them) while there's none; undefined when it keeps every one.
 */
export type ScopeRule = (library: Library, peer: string, keeps?: string) => ((item: Item) => boolean) | undefined;

/** The items in an instance's view of a library: those its rule picks and those it has. */
export function scopeOf(library: Library, keep: ((item: Item) => boolean) | undefined, have: Iterable<ItemId> = []): Set<ItemId> | undefined {
  if (!keep) return undefined;
  const ids = new Set<ItemId>();
  for (const id of have) if (library.items[id]) ids.add(id);
  for (const item of Object.values(library.items)) if (keep(item)) ids.add(item.id);
  return ids;
}

/** The library as an instance sees it: only the items in `scope`, and what refers to them. */
export function scopeLibrary(library: Library, scope: Set<ItemId>): Library {
  const items = Object.fromEntries(Object.entries(library.items).filter(([id]) => scope.has(id)));
  const userData = Object.fromEntries(
    Object.entries(library.userData).map(([userId, data]): [string, UserData] => {
      const pick = <T>(byItem: Record<ItemId, T>) => Object.fromEntries(Object.entries(byItem).filter(([id]) => scope.has(id)));
      return [userId, { ...data, ratings: pick(data.ratings), reviews: pick(data.reviews), ...(data.positions && { positions: pick(data.positions) }) }];
    }),
  );
  const devices = library.devices && Object.fromEntries(Object.entries(library.devices).map(([id, device]) => [id, scopeDevice(device, scope)]));
  return { ...library, items, userData, ...(devices && { devices }) };
}

/**
 * A device as an instance sees it: its items and placed files for the items in `scope`. What it
 * keeps off (`excluded`) stays whole: those are only ids, and the instance a connection is for has to
 * see what it keeps off itself.
 */
function scopeDevice(device: Device, scope: Set<ItemId>): Device {
  const placed = Object.fromEntries(Object.entries(device.placed).filter(([, file]) => scope.has(file.itemId)));
  const { files: all, ...rest } = device;
  const files = all && Object.fromEntries(Object.entries(all).filter(([id]) => scope.has(id)));
  return { ...rest, items: device.items.filter((id) => scope.has(id)), ...(files && Object.keys(files).length && { files }), placed };
}

/**
 * Changes as an instance sees them: those about items outside `scope` left out, and the rest cut
 * down to the items in it. Paths a device sync removed are left out too: they name books, and the
 * instance doesn't need them (a placed file it has that the hub removed is put right by the check
 * after the merge).
 */
export function scopeChanges(ops: Operation[], scope: Set<ItemId>): Operation[] {
  const scoped: Operation[] = [];
  for (const op of ops) {
    switch (op.type) {
      case 'addItem':
        if (scope.has(op.item.id)) scoped.push(op);
        break;
      case 'removeItem':
      case 'updateItem':
      case 'setMetadata':
      case 'addTags':
      case 'removeTags':
      case 'attachFile':
      case 'detachFile':
      case 'setFileMetadataKey':
        if (scope.has(op.id)) scoped.push(op);
        break;
      case 'setRating':
      case 'setReview':
      case 'setPosition':
        if (scope.has(op.itemId)) scoped.push(op);
        break;
      case 'addDevice':
        scoped.push({ ...op, device: scopeDevice(op.device, scope) });
        break;
      case 'addDeviceItems':
      case 'removeDeviceItems': {
        const itemIds = op.itemIds.filter((id) => scope.has(id));
        if (itemIds.length) scoped.push({ ...op, itemIds });
        break;
      }
      case 'setDeviceFiles':
        if (scope.has(op.itemId)) scoped.push(op);
        break;
      case 'recordDeviceSync': {
        const placed = Object.fromEntries(Object.entries(op.placed).filter(([, file]) => scope.has(file.itemId)));
        if (Object.keys(placed).length) scoped.push({ ...op, placed, removed: [] });
        break;
      }
      default:
        scoped.push(op);
    }
  }
  return scoped;
}
