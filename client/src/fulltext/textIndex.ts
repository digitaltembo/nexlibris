import type { FileHash, FileRef, Item, LibraryBackend } from '@nexlibris/common';
import { isFormatId } from '../formats/formats';
import { EXTRACTOR_VERSION, extractText, TEXT_FORMATS, WORKER_FORMATS } from './extract';
import { parseTextQuery, type BookMatch, type TextTerm } from './match';
import type { TextWork } from './textWork';
import type { Remote } from './workerRpc';

/**
 * The text of the library's books, for full-text search. It's this instance's own (local files and
 * state: not synced or backed up), so each instance indexes the files it has. Per file, keyed by
 * hash, gzipped JSON: `fulltext/<hash>.json.gz` holds the text and `fulltext/<hash>.words.json.gz`
 * its word list; local state's `fulltext` lists what's been indexed. The reading, packing and
 * searching happen in the text worker (`textWork.ts`); this reads and writes what it makes.
 */

interface Manifest {
  files: Record<FileHash, FileEntry>;
}

export interface FileEntry {
  /** The extractor that made it; older ones are indexed again. */
  version: number;
  /** Characters of text; 0 for a book with none (a scan). */
  chars: number;
  error?: string;
}

const MANIFEST = 'fulltext';
const textPath = (hash: FileHash) => `fulltext/${hash}.json.gz`;
const wordsPath = (hash: FileHash) => `fulltext/${hash}.words.json.gz`;
/** Where extractor 2 and before kept them, uncompressed in local state. */
const legacyKeys = (hash: FileHash) => [`fulltext-${hash}`, `fulltext-${hash}-words`];
/** Word lists read from storage and handed to the worker at once while searching. */
const READ_AT_ONCE = 16;

/** The file of an item whose text is searched: its best format with text. */
export function textFile(item: Item): FileRef | undefined {
  const rank = (f: FileRef) => (isFormatId(f.format) ? TEXT_FORMATS.indexOf(f.format) : -1);
  return item.files.filter((f) => rank(f) >= 0).sort((a, b) => rank(a) - rank(b))[0];
}

export interface TextResult {
  item: Item;
  file: FileRef;
  /** Rough relevance from the word lists, best first. */
  score: number;
}

export class TextIndex {
  private manifest?: Promise<Manifest>;

  constructor(
    private readonly backend: LibraryBackend,
    private readonly work: Remote<TextWork>,
  ) {}

  private load(): Promise<Manifest> {
    this.manifest ??= this.backend.readLocalState<Manifest>(MANIFEST).then((m) => m ?? { files: {} });
    return this.manifest;
  }

  async entries(): Promise<Record<FileHash, FileEntry>> {
    return (await this.load()).files;
  }

  /** The items whose text file isn't indexed (or was indexed by an older extractor). */
  async pending(items: Item[]): Promise<{ item: Item; file: FileRef }[]> {
    const { files } = await this.load();
    return items.flatMap((item) => {
      const file = textFile(item);
      return file && files[file.hash]?.version !== EXTRACTOR_VERSION ? [{ item, file }] : [];
    });
  }

  /** Extracts and stores a file's text. A file that can't be read is recorded, so it isn't tried again. */
  async add(file: FileRef): Promise<FileEntry> {
    const manifest = await this.load();
    const previous = manifest.files[file.hash];
    let entry: FileEntry;
    try {
      const data = await this.backend.getFile(file.hash);
      if (!data) throw new Error('The file is missing from storage.');
      if (!isFormatId(file.format)) throw new Error(`Unknown format ${file.format}`);
      const packed = WORKER_FORMATS.includes(file.format)
        ? await this.work.index(data, file.format)
        : await this.work.pack(await extractText(data, file.format));
      await this.backend.writeLocalFile(textPath(file.hash), packed.text);
      await this.backend.writeLocalFile(wordsPath(file.hash), packed.words);
      await this.work.forget([file.hash]);
      entry = { version: EXTRACTOR_VERSION, chars: packed.chars };
    } catch (e) {
      entry = { version: EXTRACTOR_VERSION, chars: 0, error: e instanceof Error ? e.message : String(e) };
    }
    if (previous && previous.version < 3) for (const key of legacyKeys(file.hash)) await this.backend.writeLocalState(key, null);
    manifest.files[file.hash] = entry;
    await this.backend.writeLocalState(MANIFEST, manifest);
    return entry;
  }

  /**
   * Gives `to` the index of `from`, a file with the same text (its metadata rewritten, say), so it
   * isn't indexed again. `from`'s is left for `prune` once the library no longer has it.
   */
  async carry(from: FileHash, to: FileHash): Promise<void> {
    const manifest = await this.load();
    const entry = manifest.files[from];
    if (!entry || entry.version !== EXTRACTOR_VERSION || manifest.files[to]) return;
    if (!entry.error) {
      const text = await this.backend.readLocalFile(textPath(from));
      const words = await this.backend.readLocalFile(wordsPath(from));
      if (!text || !words) return;
      await this.backend.writeLocalFile(textPath(to), text);
      await this.backend.writeLocalFile(wordsPath(to), words);
    }
    manifest.files[to] = { ...entry };
    await this.backend.writeLocalState(MANIFEST, manifest);
  }

  /** Forgets files no longer in the library, deleting their stored text. */
  async prune(items: Item[]): Promise<void> {
    const manifest = await this.load();
    const kept = new Set(items.flatMap((item) => item.files.map((f) => f.hash)));
    const gone = Object.keys(manifest.files).filter((hash) => !kept.has(hash));
    if (!gone.length) return;
    await this.work.forget(gone);
    for (const hash of gone) {
      const { version } = manifest.files[hash]!;
      delete manifest.files[hash];
      if (version < 3) for (const key of legacyKeys(hash)) await this.backend.writeLocalState(key, null);
      else for (const path of [textPath(hash), wordsPath(hash)]) await this.backend.deleteLocalFile(path);
    }
    await this.backend.writeLocalState(MANIFEST, manifest);
  }

  /** The books that may match, from their word lists, most relevant first. Their passages come from {@link match}. */
  async candidates(items: Item[], terms: TextTerm[]): Promise<TextResult[]> {
    const { files } = await this.load();
    const byHash = new Map<FileHash, { item: Item; file: FileRef }[]>();
    for (const item of items) {
      const file = textFile(item);
      if (file && files[file.hash]?.version === EXTRACTOR_VERSION && files[file.hash]!.chars) {
        byHash.set(file.hash, [...(byHash.get(file.hash) ?? []), { item, file }]);
      }
    }
    // The worker scores the lists it holds, then the rest as they're read, a batch at a time.
    const first = await this.work.score(terms, [...byHash.keys()]);
    const scores = { ...first.scores };
    for (let i = 0; i < first.missing.length; i += READ_AT_ONCE) {
      const batch = first.missing.slice(i, i + READ_AT_ONCE);
      const lists: Record<FileHash, Blob> = {};
      await Promise.all(
        batch.map(async (hash) => {
          const data = await this.backend.readLocalFile(wordsPath(hash));
          if (data?.size) lists[hash] = data;
        }),
      );
      Object.assign(scores, (await this.work.score(terms, Object.keys(lists), lists)).scores);
    }
    const results = Object.entries(scores).flatMap(([hash, score]) => byHash.get(hash)!.map((entry) => ({ ...entry, score })));
    return results.sort((a, b) => b.score - a.score || a.item.title.localeCompare(b.item.title));
  }

  /** A book's passages for the search, or undefined if, read in full, it doesn't match after all. */
  async match(hash: FileHash, terms: TextTerm[]): Promise<BookMatch | undefined> {
    let found = await this.work.match(hash, terms);
    if (found.missing) {
      const text = await this.backend.readLocalFile(textPath(hash));
      if (!text?.size) return undefined;
      found = await this.work.match(hash, terms, text);
    }
    return found.match;
  }
}

export { parseTextQuery };
