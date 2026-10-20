import type { Device, Library, LibraryBackend, Operation, PlacedFile } from '@nexlibris/common';
import { parentOf, type SyncPlan } from './plan';
import { takeOutOfDevice } from './selection';
import type { DeviceTarget } from './types';

export interface SyncProgress {
  done: number;
  total: number;
  /** What's happening now, e.g. "Sending Dune - Frank Herbert.epub". */
  current?: string;
}

export interface SyncResult {
  /** To apply to the library even if some steps failed: the record of what was done, and books deleted on the device taken out of its catalog. */
  operations: Operation[];
  sent: number;
  moved: number;
  /** Copies found on the device and taken as the books', where they were. */
  kept: number;
  /** Old copies of books sent again under a new name. */
  removed: number;
  /** Books deleted on the device, taken out of its catalog. */
  takenOut: number;
  catalogAdded: boolean;
  errors: { path: string; message: string }[];
}

/**
 * Carries out a plan. A failed step is reported and the rest carry on; the
 * record covers what succeeded. Files are sent as the library stores them.
 */
export async function runSync(
  library: Library,
  device: Device,
  plan: SyncPlan,
  target: DeviceTarget,
  backend: LibraryBackend,
  onProgress?: (progress: SyncProgress) => void,
): Promise<SyncResult> {
  const placed: Record<string, PlacedFile> = Object.fromEntries((plan.kept ?? []).map((k) => [k.path, k.placed]));
  const kept = Object.keys(placed).length;
  const removed = [...plan.forget];
  const errors: SyncResult['errors'] = [];
  const moves = plan.moves ?? [];
  const total = moves.length + plan.removals.length + plan.uploads.length + (plan.catalog ? 1 : 0);
  let moved = 0;
  let catalogAdded = false;
  let done = 0;
  const step = async (current: string, path: string, work: () => Promise<void>) => {
    onProgress?.({ done, total, current });
    try {
      await work();
    } catch (e) {
      errors.push({ path, message: e instanceof Error ? e.message : String(e) });
    }
    onProgress?.({ done: ++done, total });
  };

  const ready = new Set<string>();
  const ensureFolder = async (folder: string) => {
    if (ready.has(folder)) return;
    await target.ensureFolder(folder);
    ready.add(folder);
  };

  // Moves first: a path a book leaves may be where another goes.
  for (const move of moves) {
    await step(`Moving ${baseName(move.from)}`, move.to, async () => {
      await ensureFolder(parentOf(move.to));
      await target.move!(move.from, move.to);
      placed[move.to] = move.placed;
      removed.push(move.from);
      moved++;
    });
  }

  // Uploads next, so a book sent under a new name loses its old copy only once the new one is there.
  const failed = new Set<string>();
  for (const upload of plan.uploads) {
    await step(`Sending ${baseName(upload.path)}`, upload.path, async () => {
      try {
        await ensureFolder(parentOf(upload.path));
        const file = upload.file;
        const data = await backend.getFile(file.hash);
        if (!data) throw new Error('The file is missing from the library.');
        await target.upload(upload.path, data);
        placed[upload.path] = { itemId: upload.item.id, hash: file.hash, size: data.size };
      } catch (e) {
        if (upload.supersedes) failed.add(upload.supersedes);
        throw e;
      }
    });
  }
  for (const path of plan.removals) {
    if (failed.has(path)) {
      onProgress?.({ done: ++done, total });
      continue;
    }
    await step(`Removing ${baseName(path)}`, path, async () => {
      await target.remove(path);
      removed.push(path);
    });
  }
  // Folders books left, if now empty; the device refuses ones that aren't, which is fine.
  for (const folder of plan.emptied ?? []) await target.remove(folder).catch(() => undefined);
  const catalog = plan.catalog;
  if (catalog && target.addCatalog) {
    await step(`Adding ${catalog.name} to the reader’s catalogs`, catalog.url, async () => {
      await target.addCatalog!(catalog);
      catalogAdded = true;
    });
  }
  const takenOut = takeOutOfDevice(library, device, plan.deleted ?? []);
  return {
    catalogAdded,
    operations: [{ type: 'recordDeviceSync', id: device.id, placed, removed }, ...takenOut],
    takenOut: plan.deleted?.length ?? 0,
    sent: Object.keys(placed).length - moved - kept,
    moved,
    kept,
    removed: removed.length - plan.forget.length - moved,
    errors,
  };
}

const baseName = (path: string) => path.slice(path.lastIndexOf('/') + 1);
