import type { Device, Item } from '@nexlibris/common';
import { useEffect, useMemo, useState } from 'react';
import styled from 'styled-components';
import { addFromCatalog, inLibrary } from '../catalogs/addBook';
import { loadFeed, loadSearch, rememberPages, type CachedFeed } from '../catalogs/feedCache';
import type { OpdsBook, OpdsDownload, OpdsEntry, OpdsFeed, OpdsNavigation } from '../catalogs/opdsFeed';
import { type CatalogAuth } from '../catalogs/credentials';
import { CantDownload, fetchSignedInImage, textFetcher, type TextFetcher } from '../catalogs/remote';
import { useCatalogAuth } from '../catalogs/sources';
import { useCatalogImage, type ImageFetcher } from '../catalogs/useCatalogImage';
import { sourceOf } from '../catalogs/sources';
import { rememberTitle, SEARCH_STEP } from '../catalogs/titles';
import { useLibrary } from '../library/LibraryContext';
import { Badge, Button, Muted } from '../styles/ui';
import { catalogItemId, opdsItem } from '../catalogs/asItem';
import { availableFields, DEFAULT_COLUMNS, visibleColumns } from '../library/columns';
import { sortItems, type Sort } from '../library/search';
import { viewType } from '../plugins';
import type { View } from '../views/views';
import { CollectionDecorContext, type CollectionDecor } from './CollectionDecor';
import { LibraryGrid, type CollectionProps } from './LibraryGrid';
import { LibraryList } from './LibraryList';
import { Modal, ModalFooter } from './Modal';
import { RichText } from './RichText';

/**
 * A page of an OPDS catalog the library browses (`catalogs/`): the places it links to, then its
 * books, with "Load more" for its next page. Pages come from the cache while it's a day old
 * (`catalogs/feedCache.ts`), so returning costs the server nothing; as many pages as were loaded
 * last time are shown again. A book opens its details, where it can be added to the library.
 * Shown in the Library (`Library / <catalog>`) and on the connection's "On it…" screen.
 */

interface Props {
  device: Device;
  /** Where the catalog starts. */
  root: string;
  /** The page shown: an address, or `search:<terms>`; the catalog's start if not given. */
  step?: string;
  /** Going on to another page of the catalog. */
  onOpen(url: string, title: string): void;
  /** How the books are shown, as the library's are (grid, list, or a plugin's view); the grid if not given. */
  view?: View;
  /** The list's chosen columns. */
  listColumns?: string[];
  /** For tests and stories. */
  fetcher?: TextFetcher;
}

type State =
  | { kind: 'loading' }
  | { kind: 'failed'; message: string }
  | { kind: 'ready'; pages: CachedFeed[]; stale?: string; more?: 'loading' | string };

const NO_SELECTION: ReadonlySet<string> = new Set();

const errorMessage = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function CatalogBrowser({ device, root, step, onOpen, view = 'grid', listColumns = DEFAULT_COLUMNS, fetcher: given }: Props) {
  const { backend, library } = useLibrary();
  const signIn = useCatalogAuth(backend, device.id, root);
  const auth = signIn.ready ? signIn.auth : undefined;
  const fetcher = useMemo(() => given ?? textFetcher(auth), [given, auth]);
  const fetchImage = useMemo<ImageFetcher | undefined>(() => (auth ? (url) => fetchSignedInImage(url, auth) : undefined), [auth]);
  const [state, setState] = useState<State>({ kind: 'loading' });
  const [check, setCheck] = useState(0);
  const [open, setOpen] = useState<OpdsBook>();
  /** The list's sort, once its headers are clicked; till then, the catalog's own order. */
  const [sort, setSort] = useState<Sort>();
  const terms = step?.startsWith(SEARCH_STEP) ? step.slice(SEARCH_STEP.length) : undefined;
  const url = terms === undefined ? (step ?? root) : undefined;
  const template = sourceOf(device)?.searchTemplate?.(device);

  useEffect(() => {
    // Not before the sign-in is known, so a catalog that needs one isn't asked without it.
    if (!signIn.ready) return;
    let cancelled = false;
    const options = { check: check > 0, ...(template && { template }) };
    void (async () => {
      setState({ kind: 'loading' });
      try {
        const first =
          terms !== undefined ? await loadSearch(backend, root, terms, fetcher, options) : await loadFeed(backend, url!, fetcher, { check: options.check });
        if (cancelled) return;
        rememberTitle(step ?? root, first.cached.feed.title, { fallback: true });
        const pages = [first.cached];
        setState({ kind: 'ready', pages, ...(first.stale && { stale: first.stale }) });
        // As many pages as were loaded last time, each from the cache while it's fresh.
        for (let n = 1; n < (first.cached.pages ?? 1); n++) {
          const next = pages.at(-1)!.feed.next;
          if (!next) break;
          const loaded = await loadFeed(backend, next, fetcher, { check: options.check });
          if (cancelled) return;
          pages.push(loaded.cached);
          setState({ kind: 'ready', pages: [...pages], ...(first.stale && { stale: first.stale }) });
        }
      } catch (e) {
        if (!cancelled) setState({ kind: 'failed', message: errorMessage(e) });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [backend, fetcher, root, step, url, terms, check, template, signIn.ready]);

  const loadMore = async () => {
    if (state.kind !== 'ready') return;
    const next = state.pages.at(-1)!.feed.next;
    if (!next) return;
    setState({ ...state, more: 'loading' });
    try {
      const { cached } = await loadFeed(backend, next, fetcher);
      const pages = [...state.pages, cached];
      setState({ kind: 'ready', pages, ...(state.stale && { stale: state.stale }) });
      await rememberPages(backend, state.pages[0]!.url, pages.length);
    } catch (e) {
      setState({ ...state, more: errorMessage(e) });
    }
  };

  if (state.kind === 'loading') return <Muted as="p">Reading {device.name}…</Muted>;
  if (state.kind === 'failed') {
    return (
      <>
        <ErrorText role="alert">{state.message}</ErrorText>
        <Button $variant="secondary" $size="small" onClick={() => setCheck((n) => n + 1)}>
          Try again
        </Button>
      </>
    );
  }

  const feed = state.pages[0]!.feed;
  // Pages can overlap (a first page that repeats the start of the list it leads to): each entry once.
  const seen = new Set<string>();
  const entries = state.pages.flatMap((page) => page.feed.entries).filter((e) => !seen.has(e.id) && !!seen.add(e.id));
  const places = entries.filter((e): e is OpdsNavigation => e.kind === 'navigation');
  const books = entries.filter((e): e is OpdsBook => e.kind === 'book');
  const libraryItems = Object.values(library.items);
  const last = state.pages.at(-1)!;
  const readAt = state.pages[0]!.fetchedAt;
  const byId = new Map(books.map((book) => [catalogItemId(device.id, book), book]));
  const shown = books.map((book) => opdsItem(device.id, book, readAt));
  const items = sort ? sortItems(shown, sort) : shown;
  const owned = new Map(books.map((book) => [book, inLibrary(libraryItems, book)]));
  const decor: CollectionDecor = {
    coverUrl: (item) => byId.get(item.id)?.thumbnail,
    ...(fetchImage && { fetchImage }),
    badge: (item) => (owned.get(byId.get(item.id)!) ? 'In library' : undefined),
  };
  const collection: CollectionProps = {
    items,
    selection: NO_SELECTION,
    onActivate: (id) => setOpen(byId.get(id)),
    onLongPress: (id) => setOpen(byId.get(id)),
  };
  const PluginView = viewType(view)?.component;

  return (
    <Browser>
      <Heading>
        <div>
          {terms === undefined && <strong>{feed.title}</strong>}
          {feed.subtitle && <Muted> {feed.subtitle}</Muted>}
        </div>
        <Muted>
          {state.stale ? `Couldn’t check it: ${state.stale}` : `Read ${when(state.pages[0]!.checkedAt)}`}{' '}
          <LinkButton onClick={() => setCheck((n) => n + 1)}>Check now</LinkButton>
        </Muted>
      </Heading>
      {feed.sections.length > 0 && (
        <Sections>
          {feed.sections.map((s) => (
            <Button key={s.href} $variant="secondary" $size="small" onClick={() => onOpen(s.href, s.title)}>
              {s.title} ›
            </Button>
          ))}
        </Sections>
      )}
      {places.length > 0 && (
        <Places>
          {places.map((place) => (
            <li key={place.id}>
              <Place onClick={() => onOpen(place.href, place.title)}>
                {place.thumbnail && <img src={place.thumbnail} alt="" loading="lazy" referrerPolicy="no-referrer" />}
                <span>
                  <strong>{place.title}</strong>
                  {place.detail && <Muted>{place.detail}</Muted>}
                </span>
              </Place>
            </li>
          ))}
        </Places>
      )}
      {books.length > 0 && (
        <CollectionDecorContext.Provider value={decor}>
          {view === 'list' ? (
            <LibraryList
              {...collection}
              columns={visibleColumns(listColumns, availableFields(shown))}
              sort={sort}
              onSort={setSort}
            />
          ) : PluginView ? (
            <PluginView {...collection} />
          ) : (
            <LibraryGrid {...collection} />
          )}
        </CollectionDecorContext.Provider>
      )}
      {!entries.length && !feed.sections.length && <Muted as="p">{terms !== undefined ? `Nothing found for “${terms}”.` : 'Nothing here.'}</Muted>}
      {last.feed.next && (
        <More>
          <Button $variant="secondary" disabled={state.more === 'loading'} onClick={() => void loadMore()}>
            {state.more === 'loading' ? 'Loading…' : 'Load more'}
          </Button>
          {state.more && state.more !== 'loading' && <ErrorText role="alert">{state.more}</ErrorText>}
        </More>
      )}
      {open && <CatalogBook book={open} {...(auth && { auth })} owned={owned.get(open) ?? inLibrary(libraryItems, open)} onOpen={(to, title) => (setOpen(undefined), onOpen(to, title))} onClose={() => setOpen(undefined)} />}
    </Browser>
  );
}

/** "today at 10:04" or a date. */
function when(iso: string): string {
  const date = new Date(iso);
  const sameDay = date.toDateString() === new Date().toDateString();
  return sameDay ? `today at ${date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}` : `on ${date.toLocaleDateString()}`;
}

const sizeOf = (bytes: number) => (bytes >= 1e6 ? `${(bytes / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1e3))} KB`);
const downloadLabel = (d: OpdsDownload) => d.title ?? d.format?.toUpperCase() ?? d.type ?? 'File';

/** A catalog's book: what it says of it, its downloads (each to add to the library), and where it leads. */
export function CatalogBook({
  book,
  owned,
  auth,
  onOpen,
  onClose,
}: {
  book: OpdsBook;
  /** The catalog's sign-in, for its downloads and cover. */
  auth?: CatalogAuth;
  owned: Item | undefined;
  onOpen(url: string, title: string): void;
  onClose(): void;
}) {
  const { backend, refresh } = useLibrary();
  const [adding, setAdding] = useState<string>();
  const cover = useCatalogImage(book.cover, useMemo(() => (auth ? (url: string) => fetchSignedInImage(url, auth) : undefined), [auth]));
  const [result, setResult] = useState<{ text: string; link?: string; error?: boolean }>();

  const add = async (download: OpdsDownload) => {
    setAdding(download.href);
    setResult(undefined);
    try {
      const imported = await addFromCatalog(backend, download, auth);
      await refresh();
      const [skipped] = imported.skipped;
      setResult(
        imported.added.length
          ? { text: `Added to the library.` }
          : imported.merged.length
            ? { text: `Added the file to “${imported.merged[0]!.item.title}”.` }
            : { text: skipped ? `Not added: ${skipped.reason}.` : 'Not added.', error: true },
      );
    } catch (e) {
      setResult(e instanceof CantDownload ? { text: e.message, link: e.url, error: true } : { text: errorMessage(e), error: true });
    } finally {
      setAdding(undefined);
    }
  };

  return (
    <Modal title={book.title} onClose={adding ? () => undefined : onClose}>
      <Detail>
        {cover && <img src={cover} alt="" referrerPolicy="no-referrer" />}
        <div>
          {book.authors.length > 0 && <p>by {book.authors.join(', ')}</p>}
          {(book.published || book.language) && (
            <Muted as="p">{[book.published?.slice(0, 10), book.language].filter(Boolean).join(' · ')}</Muted>
          )}
          {owned && <Badge>In library as “{owned.title}”</Badge>}
        </div>
      </Detail>
      {book.summary && <RichText text={book.summary} />}
      {book.tags.length > 0 && <Muted as="p">{book.tags.join(' · ')}</Muted>}
      {book.downloads.length > 0 ? (
        <Downloads>
          {book.downloads.map((d) => (
            <li key={d.href}>
              <span>
                {downloadLabel(d)}
                {d.length && <Muted> · {sizeOf(d.length)}</Muted>}
              </span>
              {d.format ? (
                <Button $size="small" disabled={!!adding} onClick={() => void add(d)}>
                  {adding === d.href ? 'Adding…' : 'Add to library'}
                </Button>
              ) : (
                <Muted>nexlibris can’t read this format</Muted>
              )}
            </li>
          ))}
        </Downloads>
      ) : (
        <Muted as="p">The catalog offers no download for this book.</Muted>
      )}
      {result && (
        <p role={result.error ? 'alert' : 'status'}>
          {result.error ? <ErrorText as="span">{result.text}</ErrorText> : result.text}{' '}
          {result.link && (
            <a href={result.link} target="_blank" rel="noopener noreferrer">
              Download it
            </a>
          )}
        </p>
      )}
      {book.related.length > 0 && (
        <Sections>
          {book.related.map((r) => (
            <Button key={r.href} $variant="secondary" $size="small" disabled={!!adding} onClick={() => onOpen(r.href, r.title)}>
              {r.title} ›
            </Button>
          ))}
        </Sections>
      )}
      <ModalFooter>
        <Button $variant="secondary" disabled={!!adding} onClick={onClose}>
          Close
        </Button>
      </ModalFooter>
    </Modal>
  );
}

/** For stories: a catalog page's entries, as they'd be shown, without a server. */
export type { OpdsEntry, OpdsFeed };

const Browser = styled.div`
  display: flex;
  flex-direction: column;
  gap: 12px;
`;

const Heading = styled.div`
  display: flex;
  flex-wrap: wrap;
  gap: 4px 12px;
  align-items: baseline;
  justify-content: space-between;
`;

const LinkButton = styled.button.attrs({ type: 'button' })`
  padding: 0;
  border: none;
  background: none;
  color: var(--link, var(--highlight));
  font: inherit;
  text-decoration: underline;
  cursor: pointer;
`;

const Sections = styled.div`
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin: 8px 0;
`;

const Places = styled.ul`
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
  gap: 4px 12px;
  margin: 0;
  padding: 0;
  list-style: none;
`;

const Place = styled.button.attrs({ type: 'button' })`
  display: flex;
  gap: 10px;
  align-items: center;
  width: 100%;
  padding: 8px;
  border: none;
  border-bottom: 1px solid var(--soft-border, var(--border));
  background: none;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;

  &:hover {
    background: var(--hover);
  }

  img {
    width: 22px;
    height: 22px;
    object-fit: contain;
  }

  span {
    display: flex;
    flex-direction: column;
    min-width: 0;
  }
`;

const Detail = styled.div`
  display: flex;
  gap: 16px;
  align-items: flex-start;

  img {
    width: 120px;
    border-radius: 4px;
  }

  p {
    margin: 0 0 6px;
  }
`;

const Downloads = styled.ul`
  margin: 12px 0 0;
  padding: 0;
  list-style: none;

  li {
    display: flex;
    gap: 8px;
    align-items: center;
    justify-content: space-between;
    padding: 6px 0;
    border-top: 1px solid var(--soft-border, var(--border));
  }
`;

const More = styled.div`
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  margin: 8px 0 16px;
`;

const ErrorText = styled.p`
  margin: 0;
  color: var(--danger);
`;
