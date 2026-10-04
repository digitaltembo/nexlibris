import { describe, expect, it } from 'vitest';
import { droppedFiles } from './droppedFiles';

/** A dropped file or folder, as Chrome's `webkitGetAsEntry` gives it; folders hand out their entries two at a time. */
function entry(fullPath: string, children?: FileSystemEntry[]): FileSystemEntry {
  const name = fullPath.split('/').pop()!;
  const base = { name, fullPath, isFile: !children, isDirectory: !!children };
  if (!children) return { ...base, file: (ok: (f: File) => void) => ok(new File([fullPath], name)) } as unknown as FileSystemEntry;
  return {
    ...base,
    createReader: () => {
      let at = 0;
      return { readEntries: (ok: (e: FileSystemEntry[]) => void) => ok(children.slice(at, (at += 2))) };
    },
  } as unknown as FileSystemEntry;
}

const transfer = (entries: FileSystemEntry[], files: File[] = []) =>
  ({ files, items: entries.map((e) => ({ webkitGetAsEntry: () => e })) }) as unknown as DataTransfer;

describe('droppedFiles', () => {
  it('takes dropped files as they are', async () => {
    const files = [new File(['a'], 'a.epub')];
    expect(await droppedFiles(transfer([entry('/a.epub')], files))).toEqual(files);
  });

  it('lists a dropped folder’s files with their paths, in every batch, leaving hidden ones out', async () => {
    const folder = entry('/Library', [
      entry('/Library/b.epub'),
      entry('/Library/.caltrash', [entry('/Library/.caltrash/old.epub')]),
      entry('/Library/Herbert', [entry('/Library/Herbert/Dune.epub'), entry('/Library/Herbert/metadata.opf')]),
      entry('/Library/a.txt'),
    ]);
    const counts: number[] = [];
    const found = await droppedFiles(transfer([folder, entry('/loose.pdf')]), (count) => counts.push(count));
    expect(counts).toEqual([1, 2, 3, 4, 5]);
    expect(found.map((f) => f.webkitRelativePath || f.name)).toEqual([
      'Library/a.txt',
      'Library/b.epub',
      'Library/Herbert/Dune.epub',
      'Library/Herbert/metadata.opf',
      'loose.pdf',
    ]);
    expect(new TextDecoder().decode(await found[2]!.arrayBuffer())).toBe('/Library/Herbert/Dune.epub');
  });
});
