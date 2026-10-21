import type { FileHash } from '@nexlibris/common';
import type { FormatId } from '@nexlibris/tools/formats/formats';
import { extractText, workerFormats, type TextDoc } from '@nexlibris/tools/fulltext/extract';
import { findPassages, score, wordList, type BookMatch, type TextTerm, type WordList } from '@nexlibris/tools/fulltext/match';

/**
 * Full-text search's heavy work, done in a worker (`text.worker.ts`) so the page never waits on it:
 * reading EPUBs and text files, making word lists, compressing what's stored, and searching. It has
 * no storage of its own: the page reads and writes the files and hands them over. What it has read
 * it keeps, within a budget, so searching again doesn't read every book's words again.
 */

/** A book's text and word list as stored: gzipped JSON. */
export interface Packed {
  text: Blob;
  words: Blob;
  /** Characters of text; 0 for a book with none (a scan). */
  chars: number;
}

/** Books' text kept in memory; one can be tens of megabytes, with its CFI paths. */
const DOC_CACHE = 4;
/**
 * Roughly how many bytes of word lists are kept in memory (see {@link listSize}). A novel's is
 * about 700 KB, so this keeps a few hundred books'; a search of a bigger library reads the rest
 * again from storage.
 */
const WORDS_BUDGET = 256_000_000;

/** A word list's size in memory, roughly: its words' characters, plus each word's string, slot and count. */
const listSize = (list: WordList) => list.words.reduce((n, w) => n + w.length, 0) + list.words.length * 40;

export async function packJson(value: unknown): Promise<Blob> {
  const stream = new Blob([JSON.stringify(value)]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Response(stream).blob();
}

export async function unpackJson<T>(data: Blob): Promise<T> {
  return (await new Response(data.stream().pipeThrough(new DecompressionStream('gzip'))).json()) as T;
}

export class TextWork {
  /** Word lists read, least recently used first, with their size in {@link WORDS_BUDGET}'s terms. */
  private readonly words = new Map<FileHash, { list: WordList; size: number }>();
  private wordsSize = 0;
  private readonly docs = new Map<FileHash, TextDoc>();

  /** Reads a book's text (in a format the worker reads: {@link workerFormats}) and packs it for storing. */
  async index(data: Blob, format: FormatId): Promise<Packed> {
    if (!workerFormats().includes(format)) throw new Error(`${format} files are read in the page.`);
    return this.pack(await extractText(data, format));
  }

  /** Packs text read elsewhere (a PDF's, in the page) for storing. */
  async pack(doc: TextDoc): Promise<Packed> {
    const [text, words] = await Promise.all([packJson(doc), packJson(wordList(doc))]);
    return { text, words, chars: doc.sections.reduce((n, s) => n + s.text.length, 0) };
  }

  /**
   * How well each book's word list matches the terms (books that can't match are left out), for
   * those whose lists it has or is given in `lists`; `missing` are the ones to read and pass in.
   */
  async score(terms: TextTerm[], hashes: FileHash[], lists: Record<FileHash, Blob> = {}): Promise<{ scores: Record<FileHash, number>; missing: FileHash[] }> {
    const scores: Record<FileHash, number> = {};
    const missing: FileHash[] = [];
    for (const hash of hashes) {
      let list = this.wordList(hash);
      const data = lists[hash];
      if (!list && data) list = this.keepWords(hash, await unpackJson<WordList>(data));
      if (!list) {
        missing.push(hash);
        continue;
      }
      const found = score(list, terms);
      if (found !== undefined) scores[hash] = found;
    }
    return { scores, missing };
  }

  /** A book's passages for the terms, from its text (passed in unless it was just read); `missing` if it's needed. */
  async match(hash: FileHash, terms: TextTerm[], text?: Blob): Promise<{ match?: BookMatch; missing?: boolean }> {
    let doc = this.docs.get(hash);
    if (doc) this.docs.delete(hash);
    else if (text) doc = await unpackJson<TextDoc>(text);
    else return { missing: true };
    this.docs.set(hash, doc);
    while (this.docs.size > DOC_CACHE) this.docs.delete(this.docs.keys().next().value!);
    const match = findPassages(doc, terms);
    return match ? { match } : {};
  }

  /** Drops what it holds of these books, e.g. once they're indexed again or gone. */
  async forget(hashes: FileHash[]): Promise<void> {
    for (const hash of hashes) {
      this.wordsSize -= this.words.get(hash)?.size ?? 0;
      this.words.delete(hash);
      this.docs.delete(hash);
    }
  }

  private wordList(hash: FileHash): WordList | undefined {
    const cached = this.words.get(hash);
    if (!cached) return undefined;
    this.words.delete(hash);
    this.words.set(hash, cached);
    return cached.list;
  }

  private keepWords(hash: FileHash, list: WordList): WordList {
    const size = listSize(list);
    this.words.set(hash, { list, size });
    this.wordsSize += size;
    for (const [oldest, entry] of this.words) {
      if (this.wordsSize <= WORDS_BUDGET || oldest === hash) break;
      this.words.delete(oldest);
      this.wordsSize -= entry.size;
    }
    return list;
  }
}
