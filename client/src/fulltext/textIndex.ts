import type { FileHash, FileRef, Item, LibraryBackend } from '@nexlibris/common';
import { isFormatId } from '../formats/formats';
import { EXTRACTOR_VERSION, extractText, TEXT_FORMATS, type TextDoc } from './extract';
import { findPassages, parseTextQuery, score, wordList, type BookMatch, type TextTerm, type WordList } from './match';

/**
 * The text of the library's books, for full-text search. It's this instance's own (local state:
 * not synced or backed up), so each instance indexes the files it has. Per file, keyed by hash:
 * `fulltext-<hash>` holds the text and `fulltext-<hash>-words` its word list; `fulltext` lists
 * what's been indexed.
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
const textKey = (hash: FileHash) => `fulltext-${hash}`;
const wordsKey = (hash: FileHash) => `fulltext-${hash}-words`;
/** Books' text kept in memory; one can be tens of megabytes, with its CFI paths. */
const DOC_CACHE = 4;
/**
 * Roughly how many bytes of word lists are kept in memory (see {@link listSize}). A novel's is
 * about 700 KB, so this keeps a few hundred books'; a search of a bigger library reads the rest
 * again from storage.
 */
const WORDS_BUDGET = 256_000_000;
/** Word lists read at once while searching. */
const READ_AT_ONCE = 8;

/** A word list's size in memory, roughly: its words' characters, plus each word's string, slot and count. */
const listSize = (list: WordList) => list.words.reduce((n, w) => n + w.length, 0) + list.words.length * 40;

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
  /** Word lists read, least recently used first, with their size in {@link WORDS_BUDGET}'s terms. */
  private readonly words = new Map<FileHash, { list: Promise<WordList | undefined>; size: number }>();
  private wordsSize = 0;
  private readonly docs = new Map<FileHash, Promise<TextDoc | undefined>>();

  constructor(private readonly backend: LibraryBackend) {}

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
    let entry: FileEntry;
    try {
      const data = await this.backend.getFile(file.hash);
      if (!data) throw new Error('The file is missing from storage.');
      if (!isFormatId(file.format)) throw new Error(`Unknown format ${file.format}`);
      const doc = await extractText(data, file.format);
      const words = wordList(doc);
      await this.backend.writeLocalState(textKey(file.hash), doc);
      await this.backend.writeLocalState(wordsKey(file.hash), words);
      // Not kept: indexing goes through every book once, and a search reads what it needs.
      this.docs.delete(file.hash);
      this.forgetWords(file.hash);
      entry = { version: EXTRACTOR_VERSION, chars: doc.sections.reduce((n, s) => n + s.text.length, 0) };
    } catch (e) {
      entry = { version: EXTRACTOR_VERSION, chars: 0, error: e instanceof Error ? e.message : String(e) };
    }
    manifest.files[file.hash] = entry;
    await this.backend.writeLocalState(MANIFEST, manifest);
    return entry;
  }

  /** Forgets files no longer in the library, emptying their stored text. */
  async prune(items: Item[]): Promise<void> {
    const manifest = await this.load();
    const kept = new Set(items.flatMap((item) => item.files.map((f) => f.hash)));
    const gone = Object.keys(manifest.files).filter((hash) => !kept.has(hash));
    if (!gone.length) return;
    for (const hash of gone) {
      delete manifest.files[hash];
      this.forgetWords(hash);
      this.docs.delete(hash);
      await this.backend.writeLocalState(textKey(hash), null);
      await this.backend.writeLocalState(wordsKey(hash), null);
    }
    await this.backend.writeLocalState(MANIFEST, manifest);
  }

  private forgetWords(hash: FileHash) {
    this.wordsSize -= this.words.get(hash)?.size ?? 0;
    this.words.delete(hash);
  }

  /** A file's word list, keeping those read most recently within {@link WORDS_BUDGET}. */
  private wordList(hash: FileHash): Promise<WordList | undefined> {
    const cached = this.words.get(hash);
    if (cached) {
      this.words.delete(hash);
      this.words.set(hash, cached);
      return cached.list;
    }
    const entry = { list: this.backend.readLocalState<WordList>(wordsKey(hash)).then((l) => l ?? undefined), size: 0 };
    this.words.set(hash, entry);
    void entry.list.then((list) => {
      if (this.words.get(hash) !== entry || !list) return;
      entry.size = listSize(list);
      this.wordsSize += entry.size;
      for (const [oldest, { size }] of this.words) {
        if (this.wordsSize <= WORDS_BUDGET || oldest === hash) break;
        this.words.delete(oldest);
        this.wordsSize -= size;
      }
    }, () => this.words.get(hash) === entry && this.words.delete(hash));
    return entry.list;
  }

  /** A file's stored text, keeping the last few read. */
  doc(hash: FileHash): Promise<TextDoc | undefined> {
    let doc = this.docs.get(hash);
    if (doc) this.docs.delete(hash);
    else doc = this.backend.readLocalState<TextDoc>(textKey(hash)).then((d) => d ?? undefined);
    this.docs.set(hash, doc);
    while (this.docs.size > DOC_CACHE) this.docs.delete(this.docs.keys().next().value!);
    return doc;
  }

  /** The books that may match, from their word lists, most relevant first. Their passages come from {@link match}. */
  async candidates(items: Item[], terms: TextTerm[]): Promise<TextResult[]> {
    const { files } = await this.load();
    const results: TextResult[] = [];
    const queue = items.flatMap((item) => {
      const file = textFile(item);
      return file && files[file.hash]?.chars ? [{ item, file }] : [];
    });
    // A few at a time, so a big library's lists aren't all in memory at once.
    const read = async () => {
      for (let next = queue.shift(); next; next = queue.shift()) {
        const list = await this.wordList(next.file.hash);
        const found = list && score(list, terms);
        if (found !== undefined) results.push({ ...next, score: found });
      }
    };
    await Promise.all(Array.from({ length: READ_AT_ONCE }, read));
    return results.sort((a, b) => b.score - a.score || a.item.title.localeCompare(b.item.title));
  }

  /** A book's passages for the search, or undefined if, read in full, it doesn't match after all. */
  async match(hash: FileHash, terms: TextTerm[]): Promise<{ doc: TextDoc; match: BookMatch } | undefined> {
    const doc = await this.doc(hash);
    const match = doc && findPassages(doc, terms);
    return match && { doc: doc!, match };
  }
}

export { parseTextQuery };
