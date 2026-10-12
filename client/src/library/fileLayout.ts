import type { FileHash, FileLayout, Item, Library, Placer } from '@nexlibris/common';
import { expandPath, templateProblems } from '../devices/pathTemplate';

/**
 * Where books go in a library kept in a folder of the user's (`common/src/placedLibrary.ts`), by
 * the same path templates as a CrossPoint reader's (`devices/pathTemplate.ts`): a folder per book,
 * then its files named from the file name template, each with its format as the extension
 * (`Dune.epub`, `Dune.x4.epub`). Covers stay in `.nexlibris/`.
 */

export const DEFAULT_LAYOUT: FileLayout = { folder: '<author>/<title>', fileName: '<title>' };

/** What's wrong with a layout, if anything. */
export const layoutProblems = (layout: FileLayout) => [...templateProblems(layout.folder), ...templateProblems(layout.fileName)];

/** A book file's path by the layout, as the nth with that path. */
const pathOf = (layout: FileLayout, item: Item, format: string, n: number) =>
  expandPath(layout.folder, layout.fileName || DEFAULT_LAYOUT.fileName, item, format, n).slice(1);

/** As many tries for a free name as anyone would want. */
const MAX_SAME = 1000;
/** How far a file kept where it is may be numbered. */
const KEPT_SAME = 20;

export const placeBooks: Placer = (library: Library, layout: FileLayout, current: ReadonlyMap<FileHash, string>) => {
  // Oldest first, so a book keeps its name before one added after it.
  const items = Object.values(library.items).sort((a, b) => a.addedAt.localeCompare(b.addedAt) || a.id.localeCompare(b.id));
  const files: { hash: FileHash; item: Item; format: string }[] = [];
  const seen = new Set<FileHash>();
  for (const item of items) {
    for (const file of item.files) {
      if (seen.has(file.hash)) continue;
      seen.add(file.hash);
      files.push({ hash: file.hash, item, format: file.format });
    }
  }
  const wanted = new Map<FileHash, string>();
  const taken = new Set<string>();
  const take = (hash: FileHash, path: string) => {
    wanted.set(hash, path);
    taken.add(path.toLowerCase());
  };
  // Files already where the layout would put them stay there, " (2)" and all.
  const rest = files.filter(({ hash, item, format }) => {
    const at = current.get(hash);
    if (!at || taken.has(at.toLowerCase())) return true;
    for (let n = 1; n <= KEPT_SAME; n++) {
      if (pathOf(layout, item, format, n) !== at) continue;
      take(hash, at);
      return false;
    }
    return true;
  });
  for (const { hash, item, format } of rest) {
    for (let n = 1; n <= MAX_SAME; n++) {
      const path = pathOf(layout, item, format, n);
      if (taken.has(path.toLowerCase())) continue;
      take(hash, path);
      break;
    }
  }
  return wanted;
};
