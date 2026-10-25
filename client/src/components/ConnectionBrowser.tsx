import {
  createItem,
  type Device,
  type Item,
  type ItemId,
  type Pairing,
  peerOffer,
  readPairings,
  requestFromPeer,
  type Sort,
  sortItems,
} from '@nexlibris/common';
import { useCallback, useEffect, useState } from 'react';
import styled from 'styled-components';
import { connectionType } from '../connections';
import { importFromConnection, matchItem } from '../devices/contents';
import { listDevice } from '../devices/plan';
import { isFiles, isInstance, type Inventory, type RemoteBook } from '../devices/types';
import { availableFields, DEFAULT_COLUMNS, visibleColumns } from '../library/columns';
import { useLibrary } from '../library/LibraryContext';
import { viewType } from '../plugins';
import { Button, Muted, Spacer } from '../styles/ui';
import { connectHub } from '../sync/connect';
import { instanceName } from '../sync/hub';
import type { View } from '../views/views';
import { CollectionDecorContext, type CollectionDecor } from './CollectionDecor';
import { SyncInstance } from './InstanceSync';
import { LibraryGrid, type CollectionProps } from './LibraryGrid';
import { LibraryList } from './LibraryList';
import { ItemDetail } from './ItemDetail';
import { t } from '../i18n';

const ErrorText = styled.p`
  margin: 12px 0;
  color: var(--danger);
`;

const Heading = styled.div`
  display: flex;
  gap: 8px;
  align-items: baseline;
  margin: 0 0 12px;
`;

const NO_SELECTION: ReadonlySet<string> = new Set();
const errorMessage = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** A book on a connection, shown as an item: the library's own where it has it (an instance's are), else made from what's known. */
interface Shown {
  item: Item;
  /** On a reader or folder: its file there. */
  book?: RemoteBook;
  /** The library's copy, if it has one. */
  owned?: Item;
}

type State =
  | { kind: 'loading' }
  | { kind: 'failed'; message: string }
  | { kind: 'ready'; shown: Shown[]; note: string; pairing?: Pairing; offered?: boolean; requested?: Set<ItemId> };

/** A reader's or folder's file as an item, for the library's views. */
function remoteItem(device: Device, book: RemoteBook): Item {
  const name = book.path.slice(book.path.lastIndexOf('/') + 1);
  const item = createItem(
    {
      title: book.title ?? name.replace(/\.[^/]+$/, ''),
      creators: book.author ? [{ name: book.author, role: 'aut' }] : [],
      tags: book.tags ?? [],
      metadata: { ...(book.series && { series: book.series, ...(book.seriesIndex && { seriesIndex: book.seriesIndex }) }) },
    },
    book.modified ?? new Date(0).toISOString(),
  );
  return { ...item, id: `connection:${device.id}:${book.path}` };
}

/**
 * The books on a connection that reads, in the Library (`Library / <connection>`), in the library's
 * own views, each with "In library" where the library has it: a reader's or folder's, read from it
 * when opened; another instance's, as it shows this one (through its pairing), or as it offered
 * them at its last sync here. A book opens its details in the right-hand pane, read-only, with
 * Download (or, for one offered, Ask for it).
 */
export function ConnectionBrowser({
  device,
  view = 'grid',
  listColumns = DEFAULT_COLUMNS,
  onDetail,
}: {
  device: Device;
  view?: View;
  listColumns?: string[];
  /** A book's details opened in the right-hand pane, or closed: the page makes room for it. */
  onDetail?(open: boolean): void;
}) {
  const { library, backend, refresh } = useLibrary();
  const [state, setState] = useState<State>({ kind: 'loading' });
  const [open, setOpen] = useState<Shown>();
  useEffect(() => onDetail?.(!!open), [open, onDetail]);
  // Gone with the page (going elsewhere in the Library): its pane too.
  useEffect(() => () => onDetail?.(false), [onDetail]);
  const [downloading, setDownloading] = useState<ItemId[]>();
  const [sort, setSort] = useState<Sort>();
  const type = connectionType(device.type);

  /** Reads it; `quiet` (after a download) leaves what's shown, and the open book, in place meanwhile. */
  const load = useCallback(async (quiet = false) => {
    if (!quiet) setState({ kind: 'loading' });
    try {
      const current = await backend.getLibrary();
      if (type && isFiles(type)) {
        const target = type.target(device);
        const { description } = await target.connect();
        const inventory: Inventory = type.inventory
          ? await type.inventory(device, target, current)
          : { books: (await listDevice(device, type, target, current)).files };
        const shown = inventory.books.map((book) => {
          const owned = matchItem(current, book);
          return { item: remoteItem(device, book), book, ...(owned && { owned }) };
        });
        setState({ kind: 'ready', shown, note: [t('connectionBrowser.readFrom', { description }), inventory.note].filter(Boolean).join(' ') });
      } else if (type && isInstance(type)) {
        const pairing = (await readPairings(backend)).find((p) => p.hub.origin === device.id);
        if (pairing) {
          const { client } = await connectHub(pairing, backend, true);
          const { revision } = await client.hello(null);
          const { library: view } = await client.state({ since: revision, have: Object.keys(current.items), peer: current.origin });
          const shown = Object.values(view.items).map((item) => ({ item, ...(current.items[item.id] && { owned: current.items[item.id] }) }));
          setState({ kind: 'ready', shown, note: t('connectionBrowser.shows', { name: device.name }), pairing });
        } else {
          const offer = await peerOffer(backend, device.id);
          const note = offer.at
            ? t('connectionBrowser.offered', { name: device.name })
            : t('connectionBrowser.notOffered', { name: device.name });
          setState({ kind: 'ready', shown: offer.items.map((item) => ({ item })), note, offered: true, requested: new Set(offer.requested) });
        }
      } else {
        setState({ kind: 'failed', message: t('connectionBrowser.unreadable') });
      }
    } catch (e) {
      setState({ kind: 'failed', message: errorMessage(e) });
    }
  }, [backend, device, type]);
  // Read once, on opening (only reads), and again on Refresh.
  // oxlint-disable-next-line react/set-state-in-effect
  useEffect(() => void load(), [load]);
  // The open book as read again (now in the library, say).
  useEffect(() => {
    if (state.kind !== 'ready') return;
    // oxlint-disable-next-line react/set-state-in-effect -- follows what was read
    setOpen((was) => was && (state.shown.find((s) => s.item.id === was.item.id) ?? was));
  }, [state]);

  if (state.kind === 'loading') return <Muted as="p">{t('connectionBrowser.reading', { name: device.name })}</Muted>;
  if (state.kind === 'failed') {
    return (
      <>
        <ErrorText role="alert">{state.message}</ErrorText>
        <Button $variant="secondary" $size="small" onClick={() => void load()}>
          {t('common.tryAgain')}
        </Button>
      </>
    );
  }

  const byId = new Map(state.shown.map((s) => [s.item.id, s]));
  const items = state.shown.map((s) => s.item);
  const sorted = sort ? sortItems(items, sort) : items;
  const decor: CollectionDecor = { badge: (item) => (byId.get(item.id)?.owned || library.items[item.id] ? t('connectionBrowser.inLibrary') : undefined) };
  const collection: CollectionProps = {
    items: sorted,
    selection: open ? new Set([open.item.id]) : NO_SELECTION,
    onActivate: (id) => setOpen(byId.get(id)),
    onLongPress: (id) => setOpen(byId.get(id)),
  };
  const PluginView = viewType(view)?.component;


  return (
    <>
      <Heading>
        <Muted>
          {t('connectionBrowser.count', { note: state.note, count: items.length })}
        </Muted>
        <Spacer />
        <Button $variant="secondary" $size="small" onClick={() => void load()}>
          {t('common.refresh')}
        </Button>
      </Heading>
      {items.length === 0 ? (
        <Muted as="p">{t('connectionBrowser.nothing')}</Muted>
      ) : (
        <CollectionDecorContext.Provider value={decor}>
          {view === 'list' ? (
            <LibraryList {...collection} columns={visibleColumns(listColumns, availableFields(items))} sort={sort} onSort={setSort} />
          ) : PluginView ? (
            <PluginView {...collection} />
          ) : (
            <LibraryGrid {...collection} />
          )}
        </CollectionDecorContext.Provider>
      )}
      {open && (
        <ConnectionBook
          key={open.item.id}
          shown={open}
          state={state}
          onDownload={async () => {
            if (state.pairing) return setDownloading([open.item.id]);
            if (state.offered) {
              const asked = !state.requested?.has(open.item.id);
              await requestFromPeer(backend, device.id, [open.item.id], asked);
              return void load(true);
            }
            if (open.book && type && isFiles(type)) {
              await importFromConnection(backend, device, type, type.target(device), open.book);
              await refresh();
              await load(true);
            }
          }}
          onClose={() => setOpen(undefined)}
        />
      )}
      {downloading && state.pairing && (
        <SyncInstance
          device={device}
          pairing={state.pairing}
          direction="from"
          only={{ pull: downloading }}
          self={instanceName()}
          onBack={() => setDownloading(undefined)}
          onClose={() => (setDownloading(undefined), void load(true))}
        />
      )}
    </>
  );
}

/** A connection's book in the details pane, read-only (`ItemDetail`'s `remote`), with Download (or Ask for it). */
function ConnectionBook({
  shown,
  state,
  onDownload,
  onClose,
}: {
  shown: Shown;
  state: Extract<State, { kind: 'ready' }>;
  onDownload(): Promise<void>;
  onClose(): void;
}) {
  const { library } = useLibrary();
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string>();
  const { item, book } = shown;
  const owned = shown.owned ?? library.items[item.id];
  const asked = state.requested?.has(item.id);
  const label = state.offered
    ? asked
      ? t('connectionBrowser.dontAsk')
      : t('connectionBrowser.ask')
    : owned
      ? t('connectionBrowser.downloadFile')
      : t('connectionBrowser.download');
  return (
    <ItemDetail
      item={item}
      onClose={working ? () => undefined : onClose}
      remote={{
        ...(owned && { owned }),
        actions:
          !owned || book ? (
            <Button
              disabled={working}
              title={state.offered ? t('connectionBrowser.nextSync') : undefined}
              onClick={() => {
                setWorking(true);
                setError(undefined);
                void onDownload()
                  .catch((e: unknown) => setError(errorMessage(e)))
                  .finally(() => setWorking(false));
              }}
            >
              {working ? t('connectionBrowser.working') : label}
            </Button>
          ) : null,
        ...(book && { files: <Muted as="p">{book.path}</Muted> }),
        ...(error && { footer: <ErrorText role="alert">{error}</ErrorText> }),
      }}
    />
  );
}
