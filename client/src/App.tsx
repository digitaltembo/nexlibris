import { createItem, userData, type FileRef, type Item, type ItemId } from '@nexlibris/common';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import styled from 'styled-components';
import { BulkConvertDialog } from './components/BulkConvertDialog';
import { Breadcrumbs, CrumbAction, CrumbCount } from './components/Breadcrumbs';
import { BrowseEntries } from './components/BrowseEntries';
import { CatalogBrowser } from './components/CatalogBrowser';
import { CurrentlyReading } from './components/CurrentlyReading';
import { currentlyReading, setAsideOperations } from './library/currentlyReading';
import { librarySources, useSearchableSources } from './catalogs/sources';
import { ConnectionBrowser } from './components/ConnectionBrowser';
import { readableConnections } from './connections';
import { useConnectionStatus } from './connections/active';
import { onTitles, rememberTitle, SEARCH_STEP, titlesVersion } from './catalogs/titles';
import { BulkEditor } from './components/BulkEditor';
import { CategoriesDialog } from './components/CategoriesDialog';
import { CleanupDialog } from './components/CleanupDialog';
import { BackupDialog } from './components/BackupDialog';
import { LibraryFolderDialog } from './components/LibraryFolderDialog';
import { AppMenu, MenuButton, type MenuEntry } from './components/AppMenu';
import { ConnectionsDialog } from './components/ConnectionsDialog';
import { IsbnDialog } from './components/IsbnDialog';
import { MenuIcon } from './components/icons';
import { ItemDetail } from './components/ItemDetail';
import { LibraryGrid, type CollectionProps } from './components/LibraryGrid';
import { LibraryList } from './components/LibraryList';
import { SearchBox } from './components/SearchBox';
import { SearchDialog, type SearchMode } from './components/SearchDialog';
import { TextResults } from './components/TextResults';
import { useTextIndex } from './fulltext/TextIndexContext';
import { SettingsDialog, SORT_LABELS } from './components/SettingsDialog';
import { ViewSwitcher } from './components/ViewSwitcher';
import { viewType } from './plugins';
import { knownView, VIEWS, type View } from './views/views';
import { IMPORT_ACCEPT } from '@nexlibris/tools/formats/formats';
import { ALL_BOOKS, browse, crumbs, parentPath, viewCount, type BrowsePath } from './library/browse';
import { availableFields, DEFAULT_COLUMNS, visibleColumns } from './library/columns';
import { ALREADY_IN_LIBRARY, importFiles, type ImportResult, type ImportSource } from './library/importFiles';
import { droppedFiles } from './library/droppedFiles';
import { ImportProgress, importProgressLabel, type ImportProgressState } from './components/ImportProgress';
import { nativeImportAvailable, pickNativeFiles } from './library/nativeImport';
import { hasMenuBar, useMenuBar, type MenuBar } from './library/nativeMenu';
import { followTitleBar } from './backends/desktopBridge';
import { clickItem, NO_SELECTION, toggleItem, type SelectionState } from './library/selection';
import { useBackToClose } from './library/useBackToClose';
import { useLibrary } from './library/LibraryContext';
import { DEFAULT_DESC, filterItems, formatTerm, sortItems, type Sort, type SortKey } from './library/search';
import { searchFields } from './library/suggest';
import { usePersistentState } from './library/usePersistentState';
import { APPEARANCE_KEY, APPEARANCES, applyAppearance, type Appearance } from './styles/appearance';
import { Reader } from './reader/Reader';
import { useBluetoothHosting } from './sync/bluetoothHost';
import { useSyncHosting } from './sync/hosting';
import { NARROW } from './styles/GlobalStyle';
import { besidePanel, Button, Muted, NoticeBox } from './styles/ui';
import { followWindowColors } from './styles/windowColors';
import { openReaderWindow, readsInWindows, serveReaderWindows } from './library/readerWindow';
import { choosesServer, useServerSession } from './library/account';
import { AccountDialog } from './components/AccountDialog';
import type { PairHow } from './components/InstanceSync';

/**
 * The top bar and the breadcrumbs, held at the top while the books scroll under them. Its height is
 * `--header-height`, for anything else that sticks below it (the list's column headers).
 */
const Header = styled.div`
  position: sticky;
  top: 0;
  z-index: 1;
  background: var(--bg);
`;

const Toolbar = styled.header<{ $withPanel: boolean }>`
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  padding: 10px 16px 10px calc(16px + var(--title-bar-inset, 0px));
  background: var(--bg);
  border-bottom: 1px solid var(--border);
  ${besidePanel}

  /* Without a title bar, the top bar moves the window, except where a dialog or the reader covers it
     (drag regions would take their clicks). */
  :root[data-title-bar='inset']:not(:has(dialog[open], [data-covers-window])) & {
    -webkit-app-region: drag;

    button,
    input,
    select,
    a {
      -webkit-app-region: no-drag;
    }
  }

  h1 {
    margin: 0 8px 0 0;
    font-size: 1.15rem;
    letter-spacing: 0.02em;
  }
`;

/** What's going on (an import, a selection), beside the search. */
const Activity = styled.span`
  display: inline-flex;
  align-items: center;
  gap: 8px;
  white-space: nowrap;

  ${NARROW} {
    flex-basis: 100%;
    gap: 4px;
  }
`;

/** Select all: there for touch screens, which have no Cmd/Ctrl+A, but quiet. */
const SubtleButton = styled.button.attrs({ type: 'button' })`
  padding: 2px 4px;
  border: none;
  background: none;
  color: var(--muted);
  font: inherit;
  font-size: 0.9em;
  cursor: pointer;

  &:hover {
    color: var(--text);
    text-decoration: underline;
  }
`;

const Notice = styled(NoticeBox)<{ $withPanel: boolean }>`
  margin: 12px 16px 0;
  ${besidePanel}

  > span {
    flex: 1;
  }

  > ul {
    order: 3;
    flex-basis: 100%;
    margin: 0;
    padding-left: 1.2em;
    color: var(--muted);
  }
`;

const Main = styled.main<{ $withPanel: boolean }>`
  padding: 16px;
  /* What the books stack (a shelf's leaning book, a browse entry's covers) stays under the header. */
  isolation: isolate;
  ${besidePanel}
`;

const Empty = styled.div`
  padding: 4rem 1rem;
  text-align: center;
`;

const DropOverlay = styled.div`
  position: fixed;
  inset: 12px;
  z-index: 10;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 1.4rem;
  border: 3px dashed var(--accent);
  border-radius: 16px;
  background: color-mix(in srgb, var(--bg) 85%, transparent);
  pointer-events: none;
`;

/** Keeps `--header-height` at the header's height, which changes as the top bar wraps. */
function useHeaderHeight() {
  return useCallback((header: HTMLElement | null) => {
    if (!header) return;
    const observer = new ResizeObserver(() => {
      document.documentElement.style.setProperty('--header-height', `${header.offsetHeight}px`);
    });
    observer.observe(header);
    return () => observer.disconnect();
  }, []);
}

export function App() {
  const { library, backend, apply, refresh } = useLibrary();
  useSyncHosting(backend, refresh);
  useBluetoothHosting(backend, refresh);
  const [query, setQuery] = useState('');
  /** A search of the text inside books (`fulltext/`), shown instead of the books; never at the same time as `query`. */
  const [textQuery, setTextQuery] = useState('');
  const { progress: indexing, pause: pauseIndexing, index: textIndex } = useTextIndex();
  const [appearance, setAppearance] = usePersistentState<Appearance>(APPEARANCE_KEY, 'system');
  /** The Currently Reading notice, shown each time the app opens while books are being read, until hidden. */
  const [readingHidden, setReadingHidden] = useState(false);
  useLayoutEffect(() => applyAppearance(appearance), [appearance]);
  const [storedView, setView] = usePersistentState<View>('nexlibris:view', 'grid');
  const view = knownView(storedView);
  const PluginView = viewType(view)?.component;
  const headerHeight = useHeaderHeight();
  const [sort, setSort] = usePersistentState<Sort>('nexlibris:sort', {
    key: 'title',
    desc: false,
  });
  const [listColumns, setListColumns] = usePersistentState<string[]>('nexlibris:listColumns', DEFAULT_COLUMNS);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [cleaningUp, setCleaningUp] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuBar = hasMenuBar();
  /** The search dialog, open in one mode or the other. */
  const [searching, setSearching] = useState<SearchMode | false>(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);
  const [backingUp, setBackingUp] = useState(false);
  const [choosingFolder, setChoosingFolder] = useState(false);
  const [managingConnections, setManagingConnections] = useState<boolean | PairHow>(false);
  const [accountOpen, setAccountOpen] = useState(false);
  /** The account on this instance's server: the one the page came from, or in the apps the one chosen (none from a static host). */
  const session = useServerSession();
  // The apps can always choose a server; a page has accounts only if it came from one.
  const hasAccounts = !!session || choosesServer();
  const accountLabel = session && !session.account ? 'Sign in…' : 'Account…';
  const [addingByIsbn, setAddingByIsbn] = useState(false);
  const [selectionState, setSelectionState] = useState<SelectionState>(NO_SELECTION);
  const { selection, previewId } = selectionState;
  const [bulkEditing, setBulkEditing] = useState(false);
  const [bulkConverting, setBulkConverting] = useState(false);
  /** Files done and total, while an import runs. */
  const [importProgress, setImportProgress] = useState<ImportProgressState>();
  const [lastImport, setLastImport] = useState<ImportResult>();
  // Files the library already has are counted, not listed: importing a folder again lists only what's new.
  const importSkipped = lastImport?.skipped.filter((s) => s.reason !== ALREADY_IN_LIBRARY) ?? [];
  const importKnown = (lastImport?.skipped.length ?? 0) - importSkipped.length;
  const [dragging, setDragging] = useState(false);
  /** The book being read; `at`, a place to open at (a passage a text search found). */
  const [reading, setReading] = useState<{ itemId: ItemId; file: FileRef; at?: string }>();
  /** Where the library view is (`library/browse.ts`); All books unless browsing. */
  const [path, setPath] = usePersistentState<BrowsePath>('nexlibris:browse', ALL_BOOKS);
  /** A sort chosen in the list's headers for a level with an order of its own; forgotten on leaving it. */
  const [leafSort, setLeafSort] = useState<Sort>();
  const [editingCategories, setEditingCategories] = useState(false);

  const allItems = Object.values(library.items);
  const { ratings } = userData(library);
  /** The books the search leaves, wherever the view is. */
  const matching = useMemo(() => {
    const context = { ratings };
    return filterItems(Object.values(library.items), query, context);
  }, [library.items, query, ratings]);
  const categories = useMemo(() => Object.values(library.categories ?? {}), [library.categories]);
  /** Catalogs the library browses, listed in the Library after its own categories. */
  const sourceList = useMemo(() => librarySources(library.devices), [library.devices]);
  const sources = useMemo(() => sourceList.map(({ device }) => ({ id: device.id, name: device.name })), [sourceList]);
  /** Other connections that read (readers, folders, other instances) and are active here, listed after the catalogs. */
  const { isActive } = useConnectionStatus();
  const readable = useMemo(() => readableConnections(library).filter((c) => isActive(c.device)), [library, isActive]);
  const searchableSources = useSearchableSources(backend, library.devices, searching);
  /** Books being read, latest first: the notice above the books, and the Library's Currently reading. */
  const inProgress = useMemo(() => currentlyReading(library), [library]);
  const extras = useMemo(
    () => ({ sources, connections: readable.map(({ id, name, type }) => ({ id, name, label: type.label })), reading: inProgress.map((r) => r.item.id) }),
    [sources, readable, inProgress],
  );
  const browsed = useMemo(() => browse(matching, path, categories, { ratings }, extras), [matching, path, categories, ratings, extras]);
  // The breadcrumbs name catalog pages as they're read.
  useSyncExternalStore(onTitles, titlesVersion);
  /** The books shown: a browse level's, in its own order where it has one (series, reading), else the chosen sort. */
  const ownOrder = browsed.kind === 'books' && !!browsed.ordered && !leafSort;
  const shownSort = ownOrder ? undefined : (leafSort ?? (browsed.kind === 'books' ? browsed.sort : undefined) ?? sort);
  const items = useMemo(
    () => (browsed.kind === 'books' ? (shownSort ? sortItems(browsed.items, shownSort, ratings) : browsed.items) : []),
    [browsed, shownSort, ratings],
  );
  /** The books a text search looks in: this place's, or (at a list of authors, tags, …) all that match. */
  const textItems = browsed.kind === 'books' ? browsed.items : matching;
  const searchFieldList = useMemo(() => searchFields(Object.values(library.items)), [library.items]);
  const fields = useMemo(() => availableFields(Object.values(library.items)), [library.items]);
  const active = previewId ? library.items[previewId] : undefined;
  const selectedItems = [...selection].map((id) => library.items[id]).filter((i): i is Item => i !== undefined);
  const readingItem = reading && library.items[reading.itemId];
  const closeReader = useCallback(() => setReading(undefined), []);
  // Books read in windows of their own get their files from here, and save their positions here.
  const libraryNow = useRef(library);
  libraryNow.current = library;
  useEffect(() => serveReaderWindows(backend, () => libraryNow.current, apply), [backend, apply]);
  /** Opens a book: in a window of its own where there can be one, else over the library. */
  const read = useCallback((itemId: ItemId, file: FileRef, at?: string) => {
    if (readsInWindows() && openReaderWindow({ itemId, hash: file.hash, ...(at && { at }) })) return;
    setReading({ itemId, file, ...(at && { at }) });
  }, []);
  const showBulk = bulkEditing && selectedItems.length > 0;
  const showDetail = !showBulk && active !== undefined;
  /** Books selected other than by opening one: the bulk actions show. */
  const hasSelection = selectedItems.length > 0 && !showDetail;

  const clearSelection = () => {
    setSelectionState(NO_SELECTION);
    setBulkEditing(false);
  };
  /** A book from a connection or catalog open in the right-hand pane (its browser shows it): the page makes room. */
  const [remotePane, setRemotePane] = useState(false);
  const onRemoteDetail = useCallback((open: boolean) => {
    setRemotePane(open);
    // One pane at a time: the library's book closes.
    if (open) {
      setSelectionState(NO_SELECTION);
      setBulkEditing(false);
    }
  }, []);

  /** Opens the search: in a catalog, searching it; else as the bar's search is. */
  const openSearch = (mode?: SearchMode) =>
    setSearching(mode ?? (path[0] === 'source' && path[1] ? `source:${path[1]}` : textQuery ? 'text' : 'books'));

  /** Goes to another place in the library; a selection of several is left behind, an open preview isn't. */
  const navigate = (to: BrowsePath) => {
    setPath(to);
    setLeafSort(undefined);
    if (!showDetail) clearSelection();
  };

  // A place that's gone (a removed category, say) falls back to the Library.
  const missing = browsed.kind === 'missing';
  useEffect(() => {
    if (missing) setPath([]);
  }, [missing, setPath]);

  /** The list's headers sort the chosen sort, or this level's own order where it has one. */
  const onSort = (next: Sort) => (browsed.kind === 'books' && (browsed.sort || browsed.ordered) ? setLeafSort(next) : setSort(next));

  /** Selects just this book and opens its preview. */
  const openItem = (id: ItemId) => {
    setSelectionState({ selection: new Set([id]), anchor: id, previewId: id });
    setBulkEditing(false);
  };

  // Back closes these, innermost (registered last) first.
  useBackToClose(hasSelection, clearSelection);
  useBackToClose(showBulk, () => setBulkEditing(false));
  useBackToClose(showDetail, clearSelection);
  useBackToClose(bulkConverting, () => setBulkConverting(false));
  useBackToClose(menuOpen, () => setMenuOpen(false));
  useBackToClose(settingsOpen, () => setSettingsOpen(false));
  useBackToClose(editingCategories, () => setEditingCategories(false));
  useBackToClose(cleaningUp, () => setCleaningUp(false));
  useBackToClose(backingUp, () => setBackingUp(false));
  useBackToClose(choosingFolder, () => setChoosingFolder(false));
  useBackToClose(managingConnections !== false, () => setManagingConnections(false));
  useBackToClose(accountOpen, () => setAccountOpen(false));
  useBackToClose(searching !== false, () => setSearching(false));
  useBackToClose(reading !== undefined, closeReader);

  const onActivate: CollectionProps['onActivate'] = (id, keys) => {
    const next = clickItem(selectionState, id, items.map((i) => i.id), keys);
    if (next.previewId) setBulkEditing(false);
    setSelectionState(next);
  };

  const onLongPress: CollectionProps['onLongPress'] = (id) => setSelectionState(toggleItem(selectionState, id));

  /** Stops the import running, if any. */
  const importStop = useRef<AbortController>(undefined);
  const importBusy = importProgress !== undefined;

  /**
   * Runs an import, one at a time: `load` gets the files (from a picker, a drop, the native app),
   * showing `first` meanwhile, then they're imported with their progress shown.
   */
  const runImport = async (
    first: ImportProgressState,
    load: (signal: AbortSignal) => Promise<{ files: ImportSource[]; skipped: ImportResult['skipped'] } | undefined>,
  ) => {
    if (importStop.current) return;
    const stop = new AbortController();
    importStop.current = stop;
    setImportProgress(first);
    const resumeIndexing = pauseIndexing();
    try {
      const loaded = await load(stop.signal);
      if (stop.signal.aborted) {
        setLastImport({ added: [], merged: [], skipped: [], warnings: [], stopped: true });
        return;
      }
      if (!loaded || (!loaded.files.length && !loaded.skipped.length)) return;
      setImportProgress({ phase: 'importing', done: 0, total: 0 });
      const result = await importFiles(backend, loaded.files, {
        signal: stop.signal,
        onProgress: (done, total, current) => setImportProgress({ phase: 'importing', done, total, current }),
        onSaved: () => void refresh(),
      });
      result.skipped.unshift(...loaded.skipped);
      setLastImport(result);
      await refresh();
      const touched = [...result.added, ...result.merged.map((m) => m.item)];
      // One book imported: open it, unless that would drop a selection of several.
      if (touched.length === 1 && selectionRef.current.selection.size < 2) openItem(touched[0]!.id);
    } catch (e) {
      setLastImport({ added: [], merged: [], skipped: [{ name: 'Import', reason: e instanceof Error ? e.message : String(e) }], warnings: [] });
    } finally {
      resumeIndexing();
      importStop.current = undefined;
      setImportProgress(undefined);
    }
  };

  /** Imports files picked in the page (a file or folder input): they're there already. */
  const importPicked = (files: File[]) =>
    void runImport({ phase: 'importing', done: 0, total: 0 }, async () => ({ files, skipped: [] }));

  /** In the Android and desktop apps: the native picker, which stores the files itself (much faster on Android). */
  const importNatively = (folder: boolean) =>
    void runImport({ phase: 'finding' }, (signal) =>
      pickNativeFiles({ folder, signal, onCopy: (copied) => setImportProgress({ phase: 'copying', ...copied }) }),
    );

  const addBlankItem = async () => {
    const item = createItem({ title: 'Untitled' });
    await apply([{ type: 'addItem', item }]);
    openItem(item.id);
  };

  const runImportRef = useRef(runImport);
  runImportRef.current = runImport;

  const selectionRef = useRef(selectionState);
  selectionRef.current = selectionState;

  /** Selects every item currently shown, i.e. matching the search. */
  const selectAll = () => setSelectionState({ selection: new Set(items.map((i) => i.id)) });
  const selectAllRef = useRef(selectAll);
  selectAllRef.current = selectAll;
  const overlayOpen = reading !== undefined || settingsOpen || menuOpen || backingUp || choosingFolder || managingConnections !== false || accountOpen || editingCategories || searching;

  // Cmd/Ctrl+A selects all visible items, except where it should select text.
  useEffect(() => {
    if (overlayOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() !== 'a' || !(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return;
      const target = e.target as HTMLElement | null;
      if (target?.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])')) return;
      e.preventDefault();
      selectAllRef.current();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [overlayOpen]);

  // "/" and Cmd/Ctrl+K open the search, as in many apps, and Cmd/Ctrl+Shift+F the search inside books
  // (in the desktop app, its menu has these).
  const inText = textQuery !== '';
  useEffect(() => {
    if (overlayOpen) return;
    const onKey = (e: KeyboardEvent) => {
      const command = (e.metaKey || e.ctrlKey) && !e.altKey;
      const slash = e.key === '/' && !e.metaKey && !e.ctrlKey && !e.altKey;
      const k = command && e.key.toLowerCase() === 'k' && !e.shiftKey;
      const f = command && e.key.toLowerCase() === 'f' && e.shiftKey;
      if (!slash && !k && !f) return;
      const target = e.target as HTMLElement | null;
      if (slash && target?.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])')) return;
      if (document.querySelector('dialog[open]')) return;
      e.preventDefault();
      setSearching(f || inText ? 'text' : 'books');
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [overlayOpen, inText]);

  // Escape clears the selection (and so the preview or bulk panel), unless it's meant for a text field or a dialog.
  const anySelected = selection.size > 0;
  useEffect(() => {
    if (!anySelected || reading) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (document.querySelector('dialog[open]')) return;
      setSelectionState(NO_SELECTION);
      setBulkEditing(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [anySelected, reading]);

  // Accept files and folders dropped anywhere on the page.
  useEffect(() => {
    let depth = 0;
    const hasFiles = (e: DragEvent) => e.dataTransfer?.types.includes('Files') ?? false;
    const onEnter = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth++;
      setDragging(true);
    };
    const onLeave = (e: DragEvent) => {
      if (hasFiles(e) && --depth === 0) setDragging(false);
    };
    const onOver = (e: DragEvent) => {
      if (hasFiles(e)) e.preventDefault();
    };
    const onDrop = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth = 0;
      setDragging(false);
      if (!e.dataTransfer) return;
      // Read in the drop event, while the dropped items can still be read.
      const reading = droppedFiles(e.dataTransfer, (found) => setImportProgress({ phase: 'reading', found }));
      void runImportRef.current({ phase: 'reading', found: 0 }, async () => ({ files: await reading, skipped: [] }));
    };
    window.addEventListener('dragenter', onEnter);
    window.addEventListener('dragleave', onLeave);
    window.addEventListener('dragover', onOver);
    window.addEventListener('drop', onDrop);
    return () => {
      window.removeEventListener('dragenter', onEnter);
      window.removeEventListener('dragleave', onLeave);
      window.removeEventListener('dragover', onOver);
      window.removeEventListener('drop', onDrop);
    };
  }, []);

  /** Import: the app's own picker where there is one, else the page's file input. */
  const startImport = () => (nativeImportAvailable() ? importNatively(false) : fileInputRef.current?.click());
  /** Import a folder, such as a Calibre library: every book in it and its subfolders. */
  const startImportFolder = () => (nativeImportAvailable() ? importNatively(true) : folderInputRef.current?.click());

  /** The menu bar's Select All: the text in a field, else every item shown. */
  const selectAllCommand = () => {
    const active = document.activeElement;
    if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) active.select();
    else if (!overlayOpen) selectAll();
  };

  const menuEntries: MenuEntry[] = [
    { label: 'Search inside books…', onSelect: () => openSearch('text') },
    'separator',
    { label: importProgress ? importProgressLabel(importProgress) : 'Import files…', onSelect: startImport, disabled: importBusy },
    ...(importProgress ? [] : [{ label: 'Import folder…', onSelect: startImportFolder, disabled: importBusy }]),
    { label: 'New item', onSelect: () => void addBlankItem() },
    { label: 'Add by ISBN…', onSelect: () => setAddingByIsbn(true) },
    'separator',
    { label: 'Select all', onSelect: selectAll, disabled: items.length === 0 },
    'separator',
    { label: 'Connections…', onSelect: () => setManagingConnections(true) },
    { label: 'Backup…', onSelect: () => setBackingUp(true) },
    { label: 'Library folder…', onSelect: () => setChoosingFolder(true) },
    ...(hasAccounts ? [{ label: accountLabel, onSelect: () => setAccountOpen(true) }] : []),
    'separator',
    { label: 'Browse categories…', onSelect: () => setEditingCategories(true) },
    { label: 'Clean up library…', onSelect: () => setCleaningUp(true) },
    { label: 'Settings…', onSelect: () => setSettingsOpen(true) },
  ];

  const menuBarMenus: MenuBar[] = [
    {
      label: 'File',
      items: [
        { id: 'import', label: 'Import Files…', accelerator: 'CmdOrCtrl+O', enabled: !importBusy, run: startImport },
        { id: 'importFolder', label: 'Import Folder…', accelerator: 'CmdOrCtrl+Shift+O', enabled: !importBusy, run: startImportFolder },
        { id: 'newItem', label: 'New Item', accelerator: 'CmdOrCtrl+N', run: () => void addBlankItem() },
        { id: 'addByIsbn', label: 'Add by ISBN…', run: () => setAddingByIsbn(true) },
        { type: 'separator' },
        { id: 'backup', label: 'Backup…', run: () => setBackingUp(true) },
        { id: 'libraryFolder', label: 'Library Folder…', run: () => setChoosingFolder(true) },
        ...(hasAccounts ? [{ id: 'account', label: accountLabel.replace('Sign in', 'Sign In'), run: () => setAccountOpen(true) }] : []),
        { type: 'separator' },
        { id: 'settings', label: 'Settings…', accelerator: 'CmdOrCtrl+,', appMenu: true, run: () => setSettingsOpen(true) },
      ],
    },
    {
      label: 'Edit',
      items: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { id: 'selectAll', label: 'Select All', accelerator: 'CmdOrCtrl+A', run: selectAllCommand },
        { type: 'separator' },
        { id: 'deselectAll', label: 'Deselect All', enabled: selection.size > 0, run: clearSelection },
        { type: 'separator' },
        { id: 'find', label: 'Find…', accelerator: 'CmdOrCtrl+F', run: () => openSearch('books') },
        { id: 'findText', label: 'Find Inside Books…', accelerator: 'CmdOrCtrl+Shift+F', run: () => openSearch('text') },
      ],
    },
    {
      label: 'View',
      items: [
        ...VIEWS.map((v, i) => ({
          id: `view:${v.id}`,
          label: `as ${v.label}`,
          ...(i < 9 && { accelerator: `CmdOrCtrl+${i + 1}` }),
          kind: 'radio' as const,
          checked: view === v.id,
          run: () => setView(v.id),
        })),
        { type: 'separator' },
        {
          label: 'Sort By',
          submenu: [
            ...Object.entries(SORT_LABELS).map(([key, label]) => ({
              id: `sort:${key}`,
              label,
              kind: 'radio' as const,
              checked: sort.key === key,
              run: () => setSort({ key: key as SortKey, desc: DEFAULT_DESC[key as SortKey] }),
            })),
            { type: 'separator' },
            { id: 'sort:desc', label: 'Descending', kind: 'checkbox', checked: sort.desc, run: () => setSort({ ...sort, desc: !sort.desc }) },
          ],
        },
        {
          id: 'columns',
          label: 'Columns…',
          run: () => {
            setView('list');
            setSettingsOpen(true);
          },
        },
        {
          label: 'Appearance',
          submenu: APPEARANCES.map((a) => ({
            id: `appearance:${a.id}`,
            label: a.label,
            kind: 'radio' as const,
            checked: appearance === a.id,
            run: () => setAppearance(a.id),
          })),
        },
        { type: 'separator' },
        { role: 'reload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Go',
      items: [
        { id: 'go:library', label: 'Library', accelerator: 'CmdOrCtrl+Shift+L', run: () => navigate([]) },
        { id: 'go:up', label: 'Up a Level', accelerator: 'CmdOrCtrl+[', enabled: path.length > 0, run: () => navigate(parentPath(path)) },
        { type: 'separator' },
        { id: 'go:all', label: 'All Books', run: () => navigate(ALL_BOOKS) },
        { id: 'go:reading', label: 'Currently Reading', run: () => navigate(['reading']) },
        { id: 'go:authors', label: 'Authors', run: () => navigate(['authors']) },
        { id: 'go:series', label: 'Series', run: () => navigate(['series']) },
        ...[...categories]
          .sort((a, b) => a.name.localeCompare(b.name))
          .map((c) => ({ id: `go:category:${c.id}`, label: c.name, run: () => navigate(['category', c.id]) })),
        { id: 'go:tags', label: 'Tags', run: () => navigate(['tags']) },
        ...(sources.length || readable.length ? [{ type: 'separator' as const }] : []),
        ...sources.map((c) => ({ id: `go:source:${c.id}`, label: c.name, run: () => navigate(['source', c.id]) })),
        ...readable.map((c) => ({ id: `go:connection:${c.id}`, label: c.name, run: () => navigate(['connection', c.id]) })),
      ],
    },
    {
      label: 'Library',
      items: [
        { id: 'bulkEdit', label: 'Bulk Edit…', enabled: selectedItems.length > 0, run: () => setBulkEditing(true) },
        { id: 'bulkConvert', label: 'Bulk Convert…', enabled: selectedItems.length > 0, run: () => setBulkConverting(true) },
        { type: 'separator' },
        { id: 'categories', label: 'Browse Categories…', run: () => setEditingCategories(true) },
        { id: 'cleanup', label: 'Clean Up Library…', run: () => setCleaningUp(true) },
        { id: 'connections', label: 'Connections…', run: () => setManagingConnections(true) },
      ],
    },
  ];
  useMenuBar(menuBar ? menuBarMenus : []);
  useEffect(() => followTitleBar(), []);
  useEffect(() => followWindowColors(), []);

  const collection: CollectionProps = {
    items,
    selection,
    onActivate,
    onLongPress,
  };

  const withPanel = showBulk || showDetail || remotePane;
  const showReading = inProgress.length > 0 && !readingHidden && !textQuery && path[0] !== 'source' && path[0] !== 'reading';

  return (
    <>
      <Header ref={headerHeight}>
        <Toolbar $withPanel={withPanel}>
          {!menuBar && (
            <MenuButton onClick={() => setMenuOpen(true)}>
              <MenuIcon />
            </MenuButton>
          )}
          <h1>nexlibris</h1>
          <SearchBox
            placeholder={`Search ${allItems.length} ${allItems.length === 1 ? 'item' : 'items'}…`}
            value={textQuery || query}
            inText={textQuery !== ''}
            onOpen={() => openSearch()}
            onClear={() => {
              setQuery('');
              setTextQuery('');
            }}
          />
          {importProgress ? (
            <ImportProgress
              progress={importProgress}
              // The native picker can't be closed from here; once it's closed, the import can be stopped.
              onStop={importProgress.phase === 'finding' ? undefined : () => importStop.current?.abort()}
            />
          ) : (
            indexing && (
              <Activity role="status" title="Reading books’ text so it can be searched">
                <Muted>
                  Indexing text {indexing.done + 1}/{indexing.total}
                </Muted>
              </Activity>
            )
          )}
          {hasSelection && (
            <Activity aria-label="Selection">
              <Muted>{selectedItems.length} selected</Muted>
              <Button $variant="secondary" $size="small" aria-pressed={showBulk} onClick={() => setBulkEditing(true)}>
                Bulk edit
              </Button>
              <Button $variant="secondary" $size="small" onClick={() => setBulkConverting(true)}>
                Bulk convert
              </Button>
              {items.some((i) => !selection.has(i.id)) && (
                <SubtleButton onClick={selectAll}>Select all{query && ' shown'}</SubtleButton>
              )}
              <Button $variant="icon" aria-label="Clear selection" title="Clear selection" onClick={clearSelection}>
                ×
              </Button>
            </Activity>
          )}
          <input
            ref={fileInputRef}
            type="file"
            accept={IMPORT_ACCEPT}
            multiple
            hidden
            onChange={(e) => {
              importPicked(Array.from(e.target.files ?? []));
              e.target.value = '';
            }}
          />
          <input
            ref={(input) => {
              folderInputRef.current = input;
              // Not a React prop: picks a folder, whose files come with their paths.
              if (input) input.webkitdirectory = true;
            }}
            type="file"
            hidden
            onChange={(e) => {
              importPicked(Array.from(e.target.files ?? []));
              e.target.value = '';
            }}
          />
        </Toolbar>

        {(allItems.length > 0 || sources.length > 0 || readable.length > 0) && (
          <Breadcrumbs
            withPanel={withPanel}
            crumbs={[
              ...crumbs(allItems, path, categories, sources, readable).map((c) => ({
                label: c.label,
                onSelect: () => {
                  setTextQuery('');
                  navigate(c.path);
                },
              })),
              ...(textQuery ? [{ label: `Inside books: “${textQuery}”`, onSelect: () => undefined }] : []),
            ]}
          >
            {!textQuery && <CrumbCount>{viewCount(browsed)}</CrumbCount>}
            {!textQuery && (path.length === 0 || path[0] === 'category') && (
              <CrumbAction onClick={() => setEditingCategories(true)}>Edit categories…</CrumbAction>
            )}
            {!textQuery && <ViewSwitcher view={view} onView={setView} onSettings={() => setSettingsOpen(true)} />}
          </Breadcrumbs>
        )}
      </Header>

      {showReading && (
        <Notice $withPanel={withPanel}>
          <CurrentlyReading
            reading={inProgress}
            onRead={(r) => read(r.item.id, r.file, r.position.locator)}
            onSetAside={(r) => void apply(setAsideOperations(r))}
            onHide={() => setReadingHidden(true)}
          />
        </Notice>
      )}

      {lastImport && (
        <Notice $withPanel={withPanel} role="status">
          <span>
            {lastImport.stopped && 'Stopped. '}
            Imported {lastImport.added.length} item{lastImport.added.length === 1 ? '' : 's'}
            {lastImport.merged.length > 0 &&
              `, and added files to ${lastImport.merged.length} book${lastImport.merged.length === 1 ? '' : 's'} already in the library`}
            {importKnown > 0 && `; ${importKnown} file${importKnown === 1 ? ' was' : 's were'} in the library already`}
            {importSkipped.length > 0 && `; skipped ${importSkipped.length}`}.
          </span>
          {(lastImport.merged.length > 0 || importSkipped.length > 0 || lastImport.warnings.length > 0) && (
            <ul>
              {lastImport.merged.map((m) => (
                <li key={`m${m.item.id}`}>
                  {m.names.join(', ')}: added to “{m.item.title}”
                </li>
              ))}
              {importSkipped.map((s, i) => (
                <li key={`s${i}`}>
                  {s.name}: {s.reason}
                </li>
              ))}
              {lastImport.warnings.map((w, i) => (
                <li key={`w${i}`}>
                  {w.name}: {w.message}
                </li>
              ))}
            </ul>
          )}
          <Button $variant="icon" aria-label="Dismiss" onClick={() => setLastImport(undefined)}>
            ×
          </Button>
        </Notice>
      )}

      <Main
        $withPanel={withPanel}
        // A click on empty space clears a selection of several (but leaves an open preview).
        onClick={(e) => {
          if (hasSelection && !(e.target as Element).closest('button, a, input, select, tr')) clearSelection();
        }}
      >
        {allItems.length === 0 && browsed.kind !== 'source' && browsed.kind !== 'connection' && !((sources.length || readable.length) && path.length === 0) ? (
          <Empty>
            <p>Your library is empty.</p>
            <Muted as="p">
              Drop EPUB, PDF, MOBI, AZW3, CBZ, CBR, TXT or RTF files, or a folder of them such as a Calibre library,
              anywhere on this page, or choose {menuBar ? 'File → Import Files… or Import Folder…' : 'Import files… or Import folder… from the menu'}.
            </Muted>
          </Empty>
        ) : textQuery ? (
          <TextResults
            query={textQuery}
            items={textItems}
            onRead={(item, file, at) => read(item.id, file, at)}
            onOpenItem={openItem}
          />
        ) : browsed.kind === 'connection' ? (
          <ConnectionBrowser
            key={browsed.id}
            device={library.devices![browsed.id]!}
            view={view}
            listColumns={listColumns}
            onDetail={onRemoteDetail}
          />
        ) : browsed.kind === 'source' ? (
          <CatalogBrowser
            key={path.join('\n')}
            device={sourceList.find((s) => s.device.id === browsed.id)!.device}
            root={sourceList.find((s) => s.device.id === browsed.id)!.url}
            {...(browsed.step && { step: browsed.step })}
            view={view}
            listColumns={listColumns}
            onOpen={(url, title) => {
              rememberTitle(url, title);
              navigate([...path, url]);
            }}
            onDetail={onRemoteDetail}
          />
        ) : browsed.kind === 'entries' && browsed.entries.length > 0 ? (
          <BrowseEntries entries={browsed.entries} layout={view === 'list' ? 'list' : 'grid'} onOpen={navigate} />
        ) : items.length === 0 ? (
          <Empty>
            <Muted>
              {query ? `Nothing here matches “${query}”.` : 'Nothing here.'}
            </Muted>
          </Empty>
        ) : view === 'list' ? (
          <LibraryList {...collection} columns={visibleColumns(listColumns, fields)} sort={shownSort} onSort={onSort} />
        ) : PluginView ? (
          <PluginView {...collection} />
        ) : (
          <LibraryGrid {...collection} />
        )}
      </Main>

      {showBulk && <BulkEditor items={selectedItems} onClose={() => setBulkEditing(false)} onDeleted={clearSelection} />}
      {showDetail && (
        <ItemDetail
          key={active.id}
          item={active}
          onClose={clearSelection}
          onSelectTag={(tag) => {
            setTextQuery('');
            setQuery(formatTerm({ kind: 'field', field: 'tag', values: [tag], negate: false }));
          }}
          onRead={(file) => read(active.id, file)}
        />
      )}
      {backingUp && <BackupDialog onClose={() => setBackingUp(false)} />}
      {choosingFolder && (
        <LibraryFolderDialog
          onClose={() => setChoosingFolder(false)}
          onAccount={() => (setChoosingFolder(false), setAccountOpen(true))}
          onSyncWithAccount={() => (setChoosingFolder(false), setManagingConnections('server'))}
        />
      )}
      {managingConnections !== false && (
        <ConnectionsDialog
          onClose={() => setManagingConnections(false)}
          {...(typeof managingConnections === 'string' && { pair: managingConnections })}
        />
      )}
      {accountOpen && (
        <AccountDialog onClose={() => setAccountOpen(false)} onLibraryFolder={() => (setAccountOpen(false), setChoosingFolder(true))} />
      )}
      {searching && (
        <SearchDialog
          query={query}
          items={allItems}
          fields={searchFieldList}
          ratings={ratings}
          mode={searching}
          sources={searchableSources}
          onSearch={(q, mode) => {
            setSearching(false);
            if (mode.startsWith('source:')) {
              // A catalog's results are a place in it: Library / <catalog> / “terms”.
              setTextQuery('');
              navigate(['source', mode.slice('source:'.length), `${SEARCH_STEP}${q}`]);
              return;
            }
            setQuery(mode === 'books' ? q : '');
            setTextQuery(mode === 'text' ? q : '');
          }}
          onRead={(item, file, at) => read(item.id, file, at)}
          onClose={() => setSearching(false)}
          onOpenItem={openItem}
          {...(browsed.kind === 'books' &&
            path.join('/') !== ALL_BOOKS.join('/') && {
              scope: {
                label: crumbs(allItems, path, categories).at(-1)!.label,
                filter: (list: Item[]) => {
                  const here = browse(list, path, categories, { ratings }, extras);
                  return here.kind === 'books' ? here.items : list;
                },
              },
            })}
          onLeaveScope={() => navigate(ALL_BOOKS)}
        />
      )}
      {addingByIsbn && (
        <IsbnDialog
          onClose={() => setAddingByIsbn(false)}
          onOpen={(id) => {
            setAddingByIsbn(false);
            openItem(id);
          }}
        />
      )}
      {settingsOpen && (
        <SettingsDialog
          view={view}
          onView={setView}
          appearance={appearance}
          onAppearance={setAppearance}
          sort={sort}
          onSort={setSort}
          columns={listColumns}
          fields={fields}
          onColumns={setListColumns}
          onClose={() => setSettingsOpen(false)}
        />
      )}
      {bulkConverting && <BulkConvertDialog items={selectedItems} onClose={() => setBulkConverting(false)} />}
      {editingCategories && <CategoriesDialog onClose={() => setEditingCategories(false)} />}
      {cleaningUp && (
        <CleanupDialog
          onClose={() => setCleaningUp(false)}
          pauseIndexing={pauseIndexing}
          carryText={(from, to) => textIndex.carry(from, to)}
        />
      )}
      {menuOpen && <AppMenu entries={menuEntries} onClose={() => setMenuOpen(false)} />}
      {dragging && <DropOverlay>Drop files to import</DropOverlay>}
      {reading && readingItem && (
        <Reader key={reading.file.hash} item={readingItem} file={reading.file} at={reading.at} onClose={closeReader} />
      )}
    </>
  );
}
