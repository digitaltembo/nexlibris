import { createItem, type Device, type Item, type LibraryBackend } from '@nexlibris/common';
import { useEffect, useMemo, useState } from 'react';
import styled from 'styled-components';
import { addFromCatalog, inLibrary } from '../catalogs/addBook';
import { loadFeed, loadSearch, readCachedFeed, rememberPages, type CachedFeed } from '../catalogs/feedCache';
import { withDetails, type OpdsBook, type OpdsDownload, type OpdsEntry, type OpdsFeed, type OpdsNavigation } from '../catalogs/opdsFeed';
import { type CatalogAuth } from '../catalogs/credentials';
import { CantDownload, fetchSignedInImage, textFetcher, type TextFetcher } from '../catalogs/remote';
import { useCatalogAuth } from '../catalogs/sources';
import { type ImageFetcher } from '../catalogs/useCatalogImage';
import { sourceOf } from '../catalogs/sources';
import { rememberTitle, SEARCH_STEP } from '../catalogs/titles';
import { useLibrary } from '../library/LibraryContext';
import { Button, Muted } from '../styles/ui';
import { catalogItemId, opdsItem } from '../catalogs/asItem';
import { availableFields, DEFAULT_COLUMNS, visibleColumns } from '../library/columns';
import { sortItems, type Sort } from '../library/search';
import { viewType } from '../plugins';
import type { View } from '../views/views';
import { CollectionDecorContext, type CollectionDecor } from './CollectionDecor';
import { LibraryGrid, type CollectionProps } from './LibraryGrid';
import { LibraryList } from './LibraryList';
import { Modal, ModalFooter } from './Modal';
import { ItemDetail } from './ItemDetail';
import { EntryCards } from './BrowseEntries';
import { Cover, GeneratedCover } from './Cover';

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
  /** In a modal (a connection's "On it…"): a book's details open in another, not the right-hand pane. */
  embedded?: boolean;
  /** A book's details opened in the right-hand pane, or closed: the page makes room for it. */
  onDetail?(open: boolean): void;
}

type State =
  | { kind: 'loading' }
  | { kind: 'failed'; message: string }
  | { kind: 'ready'; pages: CachedFeed[]; stale?: string; more?: 'loading' | string };

const NO_SELECTION: ReadonlySet<string> = new Set();

/** What's known of a place without asking the catalog: from the page it leads to, if that's cached. */
interface PlaceInfo {
  detail?: string;
  thumbnail?: string;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`;

/** A place's count as words: of books where its page holds only books, else entries; "+" where there are more pages. */
function countOf(feed: OpdsFeed): string {
  const books = feed.entries.every((e) => e.kind === 'book');
  const text = plural(feed.entries.length, books ? 'book' : 'entry', books ? 'books' : 'entries');
  return feed.next ? text.replace(/^([\d,.\s]+)/, '$1+') : text;
}

/**
 * Covers and counts for a page's places, filled in as they're found: a place's own count and
 * thumbnail, else from its page where that's in the cache (the first cover there, how many it
 * holds). Nothing is fetched for them: catalogs are read only as the user opens pages.
 */
function usePlaceInfo(backend: LibraryBackend, places: OpdsNavigation[]): Map<string, PlaceInfo> {
  const [info, setInfo] = useState(new Map<string, PlaceInfo>());
  const hrefs = places.map((p) => p.href).join('\n');
  useEffect(() => {
    let cancelled = false;
    const wanted = hrefs ? hrefs.split('\n') : [];
    void Promise.all(
      wanted.map(async (href) => {
        const cached = await readCachedFeed(backend, href).catch(() => undefined);
        if (!cached || cancelled) return;
        const feed = cached.feed;
        const thumbnail = feed.entries.find((e) => e.thumbnail)?.thumbnail;
        setInfo((was) => new Map(was).set(href, { detail: countOf(feed), ...(thumbnail && { thumbnail }) }));
      }),
    );
    return () => {
      cancelled = true;
    };
  }, [backend, hrefs]);
  return info;
}

/** Under a place's name: how many it holds where that's known, else its own words if they're short (Gutenberg's author). */
function placeDetail(place: OpdsNavigation, info: PlaceInfo | undefined): string | undefined {
  if (info?.detail) return info.detail;
  if (place.count !== undefined) return plural(place.count, 'book');
  return place.detail && place.detail.length <= 60 ? place.detail : undefined;
}

/** A place as an item, for `Cover` (its image through the browser's `CollectionDecor`). */
const placeItem = (place: OpdsNavigation): Item => ({ ...createItem({ title: place.title }, new Date(0).toISOString()), id: `place:${place.href}` });

const errorMessage = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function CatalogBrowser({ device, root, step, onOpen, view = 'grid', listColumns = DEFAULT_COLUMNS, fetcher: given, embedded, onDetail }: Props) {
  const { backend, library } = useLibrary();
  const signIn = useCatalogAuth(backend, device.id, root);
  const auth = signIn.ready ? signIn.auth : undefined;
  const fetcher = useMemo(() => given ?? textFetcher(auth), [given, auth]);
  const fetchImage = useMemo<ImageFetcher | undefined>(() => (auth ? (url) => fetchSignedInImage(url, auth) : undefined), [auth]);
  const [state, setState] = useState<State>({ kind: 'loading' });
  const [check, setCheck] = useState(0);
  const [open, setOpen] = useState<OpdsBook>();
  const inPane = !!open && !embedded;
  useEffect(() => onDetail?.(inPane), [inPane, onDetail]);
  // Gone with the page (going elsewhere in the Library): its pane too.
  useEffect(() => () => onDetail?.(false), [onDetail]);
  /** The list's sort, once its headers are clicked; till then, the catalog's own order. */
  const [sort, setSort] = useState<Sort>();
  const terms = step?.startsWith(SEARCH_STEP) ? step.slice(SEARCH_STEP.length) : undefined;
  const url = terms === undefined ? (step ?? root) : undefined;
  const template = sourceOf(device)?.searchTemplate?.(device);
  const pagePlaces = state.kind === 'ready' ? state.pages.flatMap((page) => page.feed.entries).filter((e): e is OpdsNavigation => e.kind === 'navigation') : [];
  const placeInfo = usePlaceInfo(backend, pagePlaces);

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
  /** Places with a real cover to hand: their own thumbnail, or the first cover on their page if it's cached. */
  const placeCovers = new Map(
    places.flatMap((place) => {
      const thumbnail = place.thumbnail ?? placeInfo.get(place.href)?.thumbnail;
      return thumbnail ? [[placeItem(place).id, thumbnail] as const] : [];
    }),
  );
  const decor: CollectionDecor = {
    coverUrl: (item) => byId.get(item.id)?.thumbnail ?? placeCovers.get(item.id),
    ...(fetchImage && { fetchImage }),
    badge: (item) => (owned.get(byId.get(item.id)!) ? 'In library' : undefined),
  };
  const collection: CollectionProps = {
    items,
    selection: open ? new Set([catalogItemId(device.id, open)]) : NO_SELECTION,
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
        <CollectionDecorContext.Provider value={decor}>
          <EntryCards
            layout={view === 'list' ? 'list' : 'grid'}
            entries={places.map((place) => {
              const item = placeItem(place);
              const detail = placeDetail(place, placeInfo.get(place.href));
              return {
                key: place.id,
                label: place.title,
                ...(detail && { detail }),
                // The place's name drawn as a cover, unless a real one is to hand.
                cover: placeCovers.has(item.id) ? <Cover item={item} label={place.title} /> : <GeneratedCover title={place.title} />,
                onOpen: () => onOpen(place.href, place.title),
              };
            })}
          />
        </CollectionDecorContext.Provider>
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
      {open && (
        <CollectionDecorContext.Provider value={decor}>
          <CatalogBook
            key={catalogItemId(device.id, open)}
            book={open}
            asItem={(book) => opdsItem(device.id, book, readAt)}
            {...(auth && { auth })}
            fetcher={fetcher}
            embedded={!!embedded}
            onOpen={(to, title) => (setOpen(undefined), onOpen(to, title))}
            onClose={() => setOpen(undefined)}
          />
        </CollectionDecorContext.Provider>
      )}
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

/**
 * A catalog's book in the details pane, read-only (`ItemDetail`'s `remote`): what the catalog says
 * of it, Add to library (its first download nexlibris reads; each of its downloads under Files),
 * and the pages it leads to. In a modal where the browser is in one (`embedded`).
 */
export function CatalogBook({
  book: listed,
  asItem,
  auth,
  fetcher,
  embedded,
  onOpen,
  onClose,
}: {
  book: OpdsBook;
  /** A book as an item, as the catalog's views show it. */
  asItem(book: OpdsBook): Item;
  /** The catalog's sign-in, for its downloads. */
  auth?: CatalogAuth;
  /** For a book given as a link to its page (`OpdsBook.details`): reading that page. */
  fetcher: TextFetcher;
  embedded?: boolean;
  onOpen(url: string, title: string): void;
  onClose(): void;
}) {
  const { backend, library, refresh } = useLibrary();
  const [adding, setAdding] = useState<string>();
  const [result, setResult] = useState<{ text: string; link?: string; error?: boolean }>();
  // A book the list gives only as a link to its page (Gutenberg's): that page, read now it's opened.
  const [loaded, setLoaded] = useState<{ book?: OpdsBook; error?: string }>({});
  useEffect(() => {
    if (!listed.details) return;
    let cancelled = false;
    void loadFeed(backend, listed.details, fetcher).then(
      ({ cached }) => !cancelled && setLoaded({ book: withDetails(listed, cached.feed) }),
      (e: unknown) => !cancelled && setLoaded({ error: errorMessage(e) }),
    );
    return () => {
      cancelled = true;
    };
  }, [backend, listed, fetcher]);
  const book = loaded.book ?? listed;
  const reading = !!listed.details && !loaded.book && !loaded.error;
  const item = asItem(book);
  const owned = inLibrary(Object.values(library.items), book);

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
  const readable = book.downloads.filter((d) => d.format);
  const first = readable[0];

  const detail = (
    <ItemDetail
      item={item}
      embedded={!!embedded}
      onClose={adding ? () => undefined : onClose}
      remote={{
        ...(owned && { owned }),
        actions: reading ? (
          <Muted>Reading its page…</Muted>
        ) : loaded.error ? (
          <ErrorText as="span" role="alert">
            Couldn’t read its page: {loaded.error}
          </ErrorText>
        ) : first ? (
          <Button disabled={!!adding} onClick={() => void add(first)}>
            {adding === first.href ? 'Adding…' : owned ? 'Add again' : 'Add to library'}
          </Button>
        ) : (
          <Muted>{book.downloads.length ? 'nexlibris can’t read its downloads' : 'The catalog offers no download'}</Muted>
        ),
        ...(book.downloads.length > 0 && {
          files: (
            <Downloads>
              {book.downloads.map((d) => (
                <li key={d.href}>
                  <span>
                    {downloadLabel(d)}
                    {d.length && <Muted> · {sizeOf(d.length)}</Muted>}
                  </span>
                  {d.format ? (
                    <Button $variant="secondary" $size="small" disabled={!!adding} onClick={() => void add(d)}>
                      {adding === d.href ? 'Adding…' : 'Add to library'}
                    </Button>
                  ) : (
                    <Muted>nexlibris can’t read this format</Muted>
                  )}
                </li>
              ))}
            </Downloads>
          ),
        }),
        footer: (
          <>
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
          </>
        ),
      }}
    />
  );
  if (!embedded) return detail;
  return (
    <Modal title={item.title} onClose={adding ? () => undefined : onClose}>
      {detail}
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
