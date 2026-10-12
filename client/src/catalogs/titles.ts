/**
 * Names of catalog pages, for the breadcrumbs (`Library / Project Gutenberg / Popular`): a place in
 * a catalog is a path of page addresses (`library/browse.ts`), named as they're opened and loaded.
 * A search's place is `search:<terms>`.
 */

const KEY = 'nexlibris:catalogTitles';
/** Kept across reloads, as the place in a catalog is (the most recent few hundred). */
const LIMIT = 500;

function load(): Map<string, string> {
  try {
    return new Map(JSON.parse(localStorage.getItem(KEY) ?? '[]') as [string, string][]);
  } catch {
    return new Map();
  }
}

const titles = load();

function save() {
  try {
    localStorage.setItem(KEY, JSON.stringify([...titles].slice(-LIMIT)));
  } catch {
    // Not kept: the names come back as the pages are opened.
  }
}
const listeners = new Set<() => void>();
let version = 0;

export const SEARCH_STEP = 'search:';

/** Names a page; `fallback` only if it has no name yet (a feed's own title, where the link that led to it named it better). */
export function rememberTitle(url: string, title: string, { fallback = false } = {}) {
  if (titles.get(url) === title || (fallback && titles.has(url))) return;
  titles.delete(url);
  titles.set(url, title);
  save();
  version++;
  for (const listener of listeners) listener();
}

/** A step's name: the search's terms, else the page's title once known. */
export function stepTitle(step: string): string {
  if (step.startsWith(SEARCH_STEP)) return `“${step.slice(SEARCH_STEP.length)}”`;
  return titles.get(step) ?? '…';
}

/** For `useSyncExternalStore`: changes as names are learnt. */
export const titlesVersion = () => version;
export function onTitles(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
