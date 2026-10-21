import type { FileRef, Item } from '@nexlibris/common';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useLibrary } from '../library/LibraryContext';
import { EXTRACTOR_VERSION } from '@nexlibris/tools/fulltext/extract';
import type { BookMatch } from '@nexlibris/tools/fulltext/match';
import { parseTextQuery, TextIndex, textFile } from './textIndex';
import type { TextWork } from './textWork';
import { startTextWork } from './textWorker';
import type { Remote } from './workerRpc';

/** The text worker as a {@link Remote}, started when it's first called. */
function lazyWork(): Remote<TextWork> {
  let started: Promise<Remote<TextWork>> | undefined;
  return new Proxy({} as Remote<TextWork>, {
    get: (_, method: keyof TextWork | 'then') =>
      method === 'then' ? undefined : async (...args: unknown[]) => {
        started ??= startTextWork();
        return ((await started)[method] as (...a: unknown[]) => Promise<unknown>)(...args);
      },
  });
}

interface TextIndexState {
  index: TextIndex;
  /** While books are being indexed. */
  progress?: { done: number; total: number };
  /** Bumped as books are indexed, so searches run again. */
  revision: number;
  /**
   * Holds indexing (after the book it's on) until the function it returns is called, e.g. while
   * importing, which reads books too: the two at once can run the page out of memory.
   */
  pause(): () => void;
}

const Context = createContext<TextIndexState | undefined>(undefined);

/**
 * The rest after each book while indexing: as long as the book took, so indexing uses at most
 * about half a core and the page and the rest of the computer stay responsive; at least a
 * moment, at most a couple of seconds.
 */
const restAfter = (workedMs: number) => Math.min(2000, Math.max(30, workedMs));

/**
 * Keeps the library's text indexed for full-text search: in the background, one book at a time,
 * whenever books are added. Only files stored here are indexed (a sync can leave one on the hub).
 */
export function TextIndexProvider({ children }: { children: ReactNode }) {
  const { backend, library } = useLibrary();
  // One worker for the page, started on first use.
  const work = useMemo(() => lazyWork(), []);
  const index = useMemo(() => new TextIndex(backend, work), [backend, work]);
  const [progress, setProgress] = useState<TextIndexState['progress']>();
  const [revision, setRevision] = useState(0);
  const items = useRef<Item[]>([]);
  items.current = Object.values(library.items);
  /** One run at a time; a change while running asks it to look again when it's done. */
  const run = useRef<{ index: TextIndex; again: boolean }>(undefined);
  /** Pauses held, and what's waiting for them to end. */
  const paused = useRef({ count: 0, waiting: [] as (() => void)[] });

  const pause = useCallback(() => {
    const current = paused.current;
    current.count++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (--current.count === 0) for (const resume of current.waiting.splice(0)) resume();
    };
  }, []);

  useEffect(() => {
    if (run.current?.index === index) {
      run.current.again = true;
      return;
    }
    const current = { index, again: true };
    run.current = current;
    void (async () => {
      let done = 0;
      try {
        while (current.again && run.current === current) {
          current.again = false;
          await index.prune(items.current);
          const pending = await index.pending(items.current);
          const local: { file: FileRef }[] = [];
          for (const entry of pending) if (await backend.hasFile(entry.file.hash)) local.push(entry);
          for (const [i, { file }] of local.entries()) {
            if (paused.current.count) {
              setProgress(undefined);
              await new Promise<void>((resume) => paused.current.waiting.push(resume));
            }
            if (run.current !== current) return;
            setProgress({ done: done + i, total: done + local.length });
            const started = performance.now();
            await index.add(file);
            setRevision((r) => r + 1);
            await new Promise((resolve) => setTimeout(resolve, restAfter(performance.now() - started)));
          }
          done += local.length;
        }
      } catch (e) {
        console.error('Indexing book text failed', e);
      } finally {
        if (run.current === current) {
          run.current = undefined;
          setProgress(undefined);
        }
      }
    })();
  }, [index, backend, library.items]);

  const value = useMemo(() => ({ index, progress, revision, pause }), [index, progress, revision, pause]);
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function useTextIndex(): TextIndexState {
  const value = useContext(Context);
  if (!value) throw new Error('useTextIndex needs a TextIndexProvider');
  return value;
}

export interface TextHit {
  item: Item;
  file: FileRef;
  match: BookMatch;
}

/** How much of the books searched has text to search. */
export interface TextCoverage {
  /** Books with indexed text. */
  searched: number;
  /** Books with a format that has text, not indexed yet. */
  pending: number;
  /** Books whose file isn't stored here (a sync left it on the hub), so their text can't be read. */
  elsewhere: number;
  /** Books with no text to search: comics, scans, files without text, or no file. */
  without: number;
}

export interface TextSearch {
  hits: TextHit[];
  /** Still reading books' text. */
  searching: boolean;
  coverage?: TextCoverage;
}

/**
 * The books among `items` whose text matches `query`, best first, found progressively (a book is
 * added as its text is read). With `limit`, stops after that many.
 */
export function useTextSearch(query: string, items: Item[], limit = Infinity): TextSearch {
  const { index, revision } = useTextIndex();
  const { backend } = useLibrary();
  const [state, setState] = useState<TextSearch>({ hits: [], searching: false });
  /** What the hits shown are for: a new search clears them, the same one run again keeps them until it's done. */
  const shown = useRef<{ query: string; items: Item[] }>(undefined);
  // Searches run again as books are indexed, but not after every single one.
  const [settledRevision, setSettledRevision] = useState(revision);
  useEffect(() => {
    const timer = setTimeout(() => setSettledRevision(revision), revision === settledRevision ? 0 : 1500);
    return () => clearTimeout(timer);
  }, [revision, settledRevision]);

  useEffect(() => {
    let cancelled = false;
    const terms = parseTextQuery(query);
    const timer = setTimeout(async () => {
      const entries = await index.entries();
      const coverage: TextCoverage = { searched: 0, pending: 0, elsewhere: 0, without: 0 };
      for (const item of items) {
        const file = textFile(item);
        const entry = file && entries[file.hash];
        if (!file) coverage.without++;
        else if (!entry || entry.version !== EXTRACTOR_VERSION) {
          if (await backend.hasFile(file.hash)) coverage.pending++;
          else coverage.elsewhere++;
        } else if (entry.chars) coverage.searched++;
        else coverage.without++;
      }
      if (!terms.length) return !cancelled && setState({ hits: [], searching: false, coverage });
      if (cancelled) return;
      const again = shown.current?.query === query && shown.current.items === items;
      shown.current = { query, items };
      setState((s) => ({ hits: again ? s.hits : [], searching: true, coverage }));
      const hits: TextHit[] = [];
      for (const candidate of await index.candidates(items, terms)) {
        if (cancelled) return;
        const match = await index.match(candidate.file.hash, terms);
        if (match) {
          hits.push({ item: candidate.item, file: candidate.file, match });
          if (!cancelled && !again) setState({ hits: [...hits], searching: true, coverage });
        }
        if (hits.length >= limit) break;
      }
      if (!cancelled) setState({ hits, searching: false, coverage });
    }, 200);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [index, backend, query, items, limit, settledRevision]);

  return state;
}
