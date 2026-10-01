import type { FileRef, LibraryBackend, Operation, PlacedFile } from '@nexlibris/common';
import { runConversion } from '../library/convert';
import { parentOf, staleFiles, type SyncPlan } from './plan';
import type { DeviceTarget, Preparation } from './types';

export interface SyncProgress {
  done: number;
  total: number;
  /** What's happening now, e.g. "Sending Dune - Frank Herbert.epub". */
  current?: string;
}

export interface SyncResult {
  /**
   * To apply to the library even if some steps failed: files made for the device (replacing out-of-date ones),
   * and the record of what was done.
   */
  operations: Operation[];
  sent: number;
  removed: number;
  catalogAdded: boolean;
  errors: { path: string; message: string }[];
}

/**
 * Carries out a plan. A failed step is reported and the rest carry on; the
 * record covers what succeeded.
 */
export async function runSync(
  deviceId: string,
  plan: SyncPlan,
  target: DeviceTarget,
  backend: LibraryBackend,
  prepare: Preparation | undefined,
  onProgress?: (progress: SyncProgress) => void,
): Promise<SyncResult> {
  const placed: Record<string, PlacedFile> = {};
  const removed = [...plan.forget];
  const errors: SyncResult['errors'] = [];
  const total = plan.removals.length + plan.uploads.length + (plan.catalog ? 1 : 0);
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

  // Uploads first, so a book sent under a new name loses its old copy only once the new one is there.
  const failed = new Set<string>();
  const made: Operation[] = [];
  const ready = new Set<string>();
  for (const upload of plan.uploads) {
    const verb = upload.convert ? 'Optimizing and sending' : 'Sending';
    await step(`${verb} ${baseName(upload.path)}`, upload.path, async () => {
      try {
        const folder = parentOf(upload.path);
        if (!ready.has(folder)) {
          await target.ensureFolder(folder);
          ready.add(folder);
        }
        let file: FileRef = upload.file;
        let stored = await backend.getFile(file.hash);
        if (!stored) throw new Error('The file is missing from the library.');
        if (upload.convert) {
          // Kept in the library, so later syncs send it without converting again.
          file = await runConversion(backend, upload.item, file, stored, upload.convert);
          made.push({ type: 'attachFile', id: upload.item.id, file });
          for (const old of staleFiles(upload.item, upload.convert)) {
            made.push({ type: 'detachFile', id: upload.item.id, hash: old.hash });
          }
          stored = (await backend.getFile(file.hash))!;
        }
        const data = upload.key !== undefined && prepare ? await prepare.run(upload.item, file, stored) : stored;
        await target.upload(upload.path, data);
        placed[upload.path] = {
          itemId: upload.item.id,
          hash: file.hash,
          size: data.size,
          ...(upload.key !== undefined && { key: upload.key }),
        };
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
  const catalog = plan.catalog;
  if (catalog && target.addCatalog) {
    await step(`Adding ${catalog.name} to the reader’s catalogs`, catalog.url, async () => {
      await target.addCatalog!(catalog);
      catalogAdded = true;
    });
  }
  return {
    catalogAdded,
    operations: [...made, { type: 'recordDeviceSync', id: deviceId, placed, removed }],
    sent: Object.keys(placed).length,
    removed: removed.length - plan.forget.length,
    errors,
  };
}

const baseName = (path: string) => path.slice(path.lastIndexOf('/') + 1);
