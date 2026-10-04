import type { ImportSource } from './importFiles';

/** A file with the folders it was in, as a folder input gives it, so `importFiles` groups it by folder. */
export const withPath = (file: File, path: string): ImportSource => ({
  name: file.name,
  webkitRelativePath: path,
  type: file.type,
  arrayBuffer: () => file.arrayBuffer(),
});

/**
 * What was dropped on the page, looking inside dropped folders (and their subfolders, apart from
 * hidden ones) for their files, with `onFound` told how many so far. Call it in the drop event: the dropped items can only be read then,
 * though their files are listed after.
 */
export function droppedFiles(transfer: DataTransfer, onFound?: (count: number) => void): Promise<ImportSource[]> {
  const files = Array.from(transfer.files);
  const entries = Array.from(transfer.items, (item) => item.webkitGetAsEntry?.() ?? null);
  if (!entries.some((entry) => entry?.isDirectory)) return Promise.resolve(files);
  return (async () => {
    const found: ImportSource[] = [];
    for (const entry of entries) if (entry) await collect(entry, found, onFound);
    return found;
  })();
}

async function collect(entry: FileSystemEntry, found: ImportSource[], onFound?: (count: number) => void): Promise<void> {
  if (entry.name.startsWith('.')) return;
  // A top-level file's path is its name: on its own it isn't in a folder.
  const path = entry.fullPath.replace(/^\//, '');
  if (isFile(entry)) {
    const file = await new Promise<File>((resolve, reject) => entry.file(resolve, reject));
    found.push(path.includes('/') ? withPath(file, path) : file);
    onFound?.(found.length);
  } else if (isDirectory(entry)) {
    const reader = entry.createReader();
    const children: FileSystemEntry[] = [];
    // Entries come in batches until an empty one.
    for (;;) {
      const batch = await new Promise<FileSystemEntry[]>((resolve, reject) => reader.readEntries(resolve, reject));
      if (!batch.length) break;
      children.push(...batch);
    }
    for (const child of children.sort((a, b) => a.name.localeCompare(b.name))) await collect(child, found, onFound);
  }
}

const isFile = (entry: FileSystemEntry): entry is FileSystemFileEntry => entry.isFile;
const isDirectory = (entry: FileSystemEntry): entry is FileSystemDirectoryEntry => entry.isDirectory;
