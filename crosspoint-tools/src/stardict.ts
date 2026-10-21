import JSZip from 'jszip';

/**
 * StarDict dictionaries for CrossPoint (crosspoint-reader's docs/dictionary.md): one folder per
 * dictionary under `/dictionaries`, holding an uncompressed `.idx`, a `.dict` or `.dict.dz`, and
 * optionally a `.syn` and `.ifo`. Picked files are sorted into dictionaries here: archives (zip,
 * tar, tar.gz) are unpacked and a gzipped `.idx` decompressed, which the reader can't do.
 */

/** Where dictionaries go, and the hidden root the reader also reads. */
export const DICTIONARY_ROOT = '/dictionaries';
export const HIDDEN_DICTIONARY_ROOT = '/.dictionaries';

export interface DictionaryFile {
  name: string;
  data: Blob;
}

export interface PreparedDictionary {
  /** The folder's name, which the reader shows on its tabs. */
  name: string;
  /** The `.ifo`'s name for it, if it has one. */
  title?: string;
  words?: number;
  files: DictionaryFile[];
}

export interface Prepared {
  dictionaries: PreparedDictionary[];
  /** Files or groups that couldn't be used, and why. */
  problems: string[];
}

/** A picked file, with the folders it was in (`webkitRelativePath`) when a folder was picked. */
export interface PickedFile {
  path: string;
  data: Blob;
}

/** A dictionary file's role, by the end of its name. */
const PARTS: [RegExp, string][] = [
  [/\.idx\.gz$/i, 'idx.gz'],
  [/\.idx$/i, 'idx'],
  [/\.dict\.dz$/i, 'dict.dz'],
  [/\.dict$/i, 'dict'],
  [/\.syn$/i, 'syn'],
  [/\.ifo$/i, 'ifo'],
];

function part(name: string): { stem: string; kind: string } | undefined {
  for (const [pattern, kind] of PARTS) if (pattern.test(name)) return { stem: name.replace(pattern, ''), kind };
  return undefined;
}

/** A name the reader takes for a folder: no slashes or odd characters. */
export const folderName = (text: string) => text.replace(/[^\w\-. ]+/g, '').replace(/^\.+/, '').trim().slice(0, 48) || 'dictionary';

/** An `.ifo`'s `key=value` lines. */
export function parseIfo(text: string): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const at = line.indexOf('=');
    if (at > 0) fields[line.slice(0, at).trim()] = line.slice(at + 1).trim();
  }
  return fields;
}

async function gunzip(data: Blob): Promise<Blob> {
  return new Response(data.stream().pipeThrough(new DecompressionStream('gzip'))).blob();
}

const text = (bytes: Uint8Array, start: number, length: number) => {
  const slice = bytes.subarray(start, start + length);
  const end = slice.indexOf(0);
  return new TextDecoder().decode(end < 0 ? slice : slice.subarray(0, end));
};

/** A tar archive's files (ustar, with GNU long names). Exported for tests. */
export function untar(bytes: Uint8Array<ArrayBuffer>): PickedFile[] {
  const files: PickedFile[] = [];
  let longName: string | undefined;
  for (let at = 0; at + 512 <= bytes.length; ) {
    const name = text(bytes, at, 100);
    if (!name) break;
    const size = parseInt(text(bytes, at + 124, 12).trim() || '0', 8);
    const type = String.fromCharCode(bytes[at + 156]!);
    const prefix = text(bytes, at + 345, 155);
    const body = bytes.slice(at + 512, at + 512 + size);
    if (type === 'L') longName = text(body, 0, size);
    else {
      if (type === '0' || type === '\0') files.push({ path: longName ?? (prefix ? `${prefix}/${name}` : name), data: new Blob([body]) });
      longName = undefined;
    }
    at += 512 + Math.ceil(size / 512) * 512;
  }
  return files;
}

/** Picked files with any archives among them unpacked. */
async function unpack(picked: PickedFile[], problems: string[]): Promise<PickedFile[]> {
  const files: PickedFile[] = [];
  for (const file of picked) {
    const lower = file.path.toLowerCase();
    try {
      if (lower.endsWith('.zip')) {
        const zip = await JSZip.loadAsync(await file.data.arrayBuffer());
        for (const entry of Object.values(zip.files)) {
          if (!entry.dir) files.push({ path: entry.name, data: await entry.async('blob') });
        }
      } else if (/\.(tar\.gz|tgz)$/.test(lower)) {
        files.push(...untar(new Uint8Array(await (await gunzip(file.data)).arrayBuffer())));
      } else if (lower.endsWith('.tar')) {
        files.push(...untar(new Uint8Array(await file.data.arrayBuffer())));
      } else if (/\.(tar\.bz2|tbz2?|tar\.xz|7z|rar)$/.test(lower)) {
        problems.push(`${baseName(file.path)}: unpack this on your computer first; nexlibris reads zip, tar and tar.gz.`);
      } else {
        files.push(file);
      }
    } catch {
      problems.push(`${baseName(file.path)}: couldn’t be unpacked.`);
    }
  }
  return files;
}

const baseName = (path: string) => path.slice(path.lastIndexOf('/') + 1);
const folderOf = (path: string) => path.slice(0, Math.max(0, path.lastIndexOf('/')));

/** Sorts picked files (loose, in folders, or in archives) into dictionaries ready to copy to the reader. */
export async function prepareDictionaries(picked: PickedFile[]): Promise<Prepared> {
  const problems: string[] = [];
  const files = await unpack(picked, problems);
  // Grouped by folder and stem, so a folder of several dictionaries gives several.
  const groups = new Map<string, { folder: string; stem: string; parts: Map<string, PickedFile> }>();
  for (const file of files) {
    const name = baseName(file.path);
    const found = part(name);
    if (!found || name.startsWith('.')) continue;
    const folder = folderOf(file.path);
    const key = `${folder}\n${found.stem}`;
    const group = groups.get(key) ?? { folder, stem: found.stem, parts: new Map() };
    group.parts.set(found.kind, file);
    groups.set(key, group);
  }

  const dictionaries: PreparedDictionary[] = [];
  const stemsIn = (folder: string) => [...groups.values()].filter((g) => g.folder === folder).length;
  for (const { folder, stem, parts } of groups.values()) {
    const label = stem || baseName(folder);
    const idx = parts.get('idx') ?? parts.get('idx.gz');
    const dict = parts.get('dict.dz') ?? parts.get('dict');
    if (!idx || !dict) {
      problems.push(`${label}: a dictionary needs its ${idx ? '.dict or .dict.dz' : '.idx'} file too.`);
      continue;
    }
    const ifoFile = parts.get('ifo');
    const ifo = ifoFile ? parseIfo(await ifoFile.data.text()) : {};
    if (ifo.idxoffsetbits === '64') {
      problems.push(`${label}: uses 64-bit offsets, which CrossPoint can’t read.`);
      continue;
    }
    let index: DictionaryFile;
    try {
      index = parts.has('idx') ? { name: `${stem}.idx`, data: idx.data } : { name: `${stem}.idx`, data: await gunzip(idx.data) };
    } catch {
      problems.push(`${label}: its .idx.gz couldn’t be decompressed.`);
      continue;
    }
    const kept = [index, { name: baseName(dict.path), data: dict.data }];
    const syn = parts.get('syn');
    if (syn) kept.push({ name: baseName(syn.path), data: syn.data });
    if (ifoFile) kept.push({ name: baseName(ifoFile.path), data: ifoFile.data });
    // The folder's name when it holds just this one, as dictionary downloads name their folders well.
    const name = folderName(folder && stemsIn(folder) === 1 ? baseName(folder) : stem);
    const words = Number(ifo.wordcount);
    dictionaries.push({
      name,
      ...(ifo.bookname && { title: ifo.bookname }),
      ...(Number.isFinite(words) && words > 0 && { words }),
      files: kept,
    });
  }
  if (!dictionaries.length && !problems.length) problems.push('No StarDict dictionary (.idx and .dict files) was found in what was picked.');
  return { dictionaries, problems };
}

/** Files the reader makes beside a dictionary's, and rebuilds when they're gone. */
export const isSidecar = (name: string) => /\.(qidx|sidx)$/i.test(name);
