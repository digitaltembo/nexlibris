import { createItem, userData, type FileRef, type Item, type ItemId } from '@nexlibris/common';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import styled from 'styled-components';
import { BulkEditor } from './components/BulkEditor';
import { ColumnsDialog } from './components/ColumnsDialog';
import { ItemDetail } from './components/ItemDetail';
import { LibraryGrid, type CollectionProps } from './components/LibraryGrid';
import { LibraryList } from './components/LibraryList';
import { IMPORT_ACCEPT } from './formats/formats';
import { availableFields, DEFAULT_COLUMNS, visibleColumns } from './library/columns';
import { importFiles, type ImportResult } from './library/importFiles';
import { useLibrary } from './library/LibraryContext';
import { DEFAULT_DESC, filterItems, sortItems, type Sort, type SortKey } from './library/search';
import { usePersistentState } from './library/usePersistentState';
import { Reader } from './reader/Reader';
import { besidePanel, Button, FileButton, Muted } from './styles/ui';

type View = 'grid' | 'list';

const Toolbar = styled.header<{ $withPanel: boolean }>`
  position: sticky;
  top: 0;
  z-index: 1;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  padding: 10px 16px;
  background: var(--bg);
  border-bottom: 1px solid var(--border);
  ${besidePanel}

  h1 {
    margin: 0 8px 0 0;
    font-size: 1.15rem;
    letter-spacing: 0.02em;
  }
`;

const Search = styled.input`
  flex: 1 1 180px;
`;

const Segmented = styled.div`
  display: inline-flex;

  > button {
    padding: 6px 12px;
    border: 1px solid var(--border);
    border-radius: 0;
    background: var(--surface);
    color: var(--text);
  }

  > button:first-child {
    border-radius: var(--radius) 0 0 var(--radius);
  }

  > button:last-child {
    border-left: none;
    border-radius: 0 var(--radius) var(--radius) 0;
  }

  > button[aria-pressed='true'] {
    background: var(--surface-2);
    font-weight: 600;
  }
`;

const SortControl = styled.div`
  display: inline-flex;

  > select {
    border-radius: var(--radius) 0 0 var(--radius);
  }

  > button {
    padding: 6px 10px;
    border-left: none;
    border-radius: 0 var(--radius) var(--radius) 0;
  }
`;

const Notice = styled.div<{ $withPanel: boolean }>`
  display: flex;
  flex-wrap: wrap;
  align-items: flex-start;
  gap: 4px 12px;
  margin: 12px 16px 0;
  padding: 8px 12px;
  background: var(--surface-2);
  border-radius: var(--radius);
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

const SORT_LABELS: Record<SortKey, string> = {
  title: 'Title',
  author: 'Author',
  series: 'Series',
  rating: 'Rating',
  added: 'Date added',
};

export function App() {
  const { library, backend, apply, refresh } = useLibrary();
  const [query, setQuery] = useState('');
  const [view, setView] = usePersistentState<View>('nexlibris:view', 'grid');
  const [sort, setSort] = usePersistentState<Sort>('nexlibris:sort', {
    key: 'title',
    desc: false,
  });
  const [listColumns, setListColumns] = usePersistentState<string[]>('nexlibris:listColumns', DEFAULT_COLUMNS);
  const [choosingColumns, setChoosingColumns] = useState(false);
  const [activeId, setActiveId] = useState<ItemId>();
  const [selecting, setSelecting] = useState(false);
  const [selection, setSelection] = useState<ReadonlySet<ItemId>>(new Set());
  const anchorRef = useRef<ItemId>(undefined);
  const [importing, setImporting] = useState(false);
  const [lastImport, setLastImport] = useState<ImportResult>();
  const [dragging, setDragging] = useState(false);
  const [reading, setReading] = useState<{ itemId: ItemId; file: FileRef }>();

  const allItems = Object.values(library.items);
  const { ratings } = userData(library);
  const items = useMemo(
    () => sortItems(filterItems(Object.values(library.items), query), sort, ratings),
    [library.items, query, sort, ratings],
  );
  const fields = useMemo(() => availableFields(Object.values(library.items)), [library.items]);
  const active = activeId ? library.items[activeId] : undefined;
  const selectedItems = [...selection].map((id) => library.items[id]).filter((i): i is Item => i !== undefined);
  const readingItem = reading && library.items[reading.itemId];
  const closeReader = useCallback(() => setReading(undefined), []);
  const showBulk = selecting && selectedItems.length > 0;
  const showDetail = !selecting && active !== undefined;

  const stopSelecting = () => {
    setSelecting(false);
    setSelection(new Set());
  };

  const onActivate: CollectionProps['onActivate'] = (id, { shiftKey, metaKey, ctrlKey }) => {
    if (!selecting && (metaKey || ctrlKey)) {
      // Cmd/Ctrl-click starts a selection, keeping the open item in it.
      setSelecting(true);
      setSelection(new Set(activeId && activeId !== id ? [activeId, id] : [id]));
      anchorRef.current = id;
      return;
    }
    if (!selecting) {
      setActiveId(id);
      return;
    }
    const next = new Set(selection);
    const anchorIndex = items.findIndex((i) => i.id === anchorRef.current);
    const index = items.findIndex((i) => i.id === id);
    if (shiftKey && anchorIndex >= 0 && index >= 0) {
      const [from, to] = anchorIndex < index ? [anchorIndex, index] : [index, anchorIndex];
      for (const item of items.slice(from, to + 1)) next.add(item.id);
    } else if (next.has(id)) {
      next.delete(id);
    } else {
      next.add(id);
    }
    anchorRef.current = id;
    setSelection(next);
  };

  const runImport = async (files: File[]) => {
    if (!files.length) return;
    setImporting(true);
    try {
      const result = await importFiles(backend, files);
      setLastImport(result);
      await refresh();
      if (result.added.length === 1 && !selecting) setActiveId(result.added[0]!.id);
    } finally {
      setImporting(false);
    }
  };

  const addBlankItem = async () => {
    const item = createItem({ title: 'Untitled' });
    await apply([{ type: 'addItem', item }]);
    stopSelecting();
    setActiveId(item.id);
  };

  const runImportRef = useRef(runImport);
  runImportRef.current = runImport;

  /** Selects every item currently shown, i.e. matching the search. */
  const selectAll = () => {
    setSelecting(true);
    setSelection(new Set(items.map((i) => i.id)));
  };
  const selectAllRef = useRef(selectAll);
  selectAllRef.current = selectAll;
  const overlayOpen = reading !== undefined || choosingColumns;

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

  // Escape leaves selection mode, unless it's meant for a text field.
  useEffect(() => {
    if (!selecting) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      setSelecting(false);
      setSelection(new Set());
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selecting]);

  // Accept files dropped anywhere on the page.
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
      void runImportRef.current(Array.from(e.dataTransfer?.files ?? []));
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

  const collection: CollectionProps = {
    items,
    activeId,
    selecting,
    selection,
    onActivate,
  };

  const withPanel = showBulk || showDetail;

  return (
    <>
      <Toolbar $withPanel={withPanel}>
        <h1>nexlibris</h1>
        <Search
          type="search"
          placeholder={`Search ${allItems.length} items…`}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <Segmented role="group" aria-label="View">
          {(['grid', 'list'] as const).map((v) => (
            <button key={v} type="button" aria-pressed={view === v} onClick={() => setView(v)}>
              {v === 'grid' ? 'Grid' : 'List'}
            </button>
          ))}
        </Segmented>
        {/* In the list view, the column headers sort. */}
        {view === 'grid' && (
          <SortControl>
            <select
              value={sort.key}
              aria-label="Sort by"
              onChange={(e) => {
                const key = e.target.value as SortKey;
                setSort({ key, desc: DEFAULT_DESC[key] });
              }}
            >
              {Object.entries(SORT_LABELS).map(([key, label]) => (
                <option key={key} value={key}>
                  {label}
                </option>
              ))}
            </select>
            <Button
              $variant="secondary"
              aria-label={sort.desc ? 'Sorted descending; sort ascending' : 'Sorted ascending; sort descending'}
              onClick={() => setSort({ ...sort, desc: !sort.desc })}
            >
              {sort.desc ? '↓' : '↑'}
            </Button>
          </SortControl>
        )}
        {view === 'list' && (
          <Button $variant="secondary" onClick={() => setChoosingColumns(true)}>
            Columns…
          </Button>
        )}
        {selecting ? (
          <>
            <Button $variant="secondary" onClick={selectAll}>
              Select all{query && ' matching'}
            </Button>
            <Button onClick={stopSelecting}>Done</Button>
          </>
        ) : (
          <>
            <Button $variant="secondary" disabled={allItems.length === 0} onClick={() => setSelecting(true)}>
              Select
            </Button>
            <FileButton>
              {importing ? 'Importing…' : 'Import files'}
              <input
                type="file"
                accept={IMPORT_ACCEPT}
                multiple
                hidden
                disabled={importing}
                onChange={(e) => {
                  void runImport(Array.from(e.target.files ?? []));
                  e.target.value = '';
                }}
              />
            </FileButton>
            <Button $variant="secondary" onClick={() => void addBlankItem()}>
              New item
            </Button>
          </>
        )}
      </Toolbar>

      {selecting && selectedItems.length === 0 && (
        <Notice $withPanel={withPanel} role="status">
          <Muted>Click items to select them. Shift-click selects a range.</Muted>
        </Notice>
      )}

      {lastImport && (
        <Notice $withPanel={withPanel} role="status">
          <span>
            Imported {lastImport.added.length} item{lastImport.added.length === 1 ? '' : 's'}
            {lastImport.skipped.length > 0 && `, skipped ${lastImport.skipped.length}`}.
          </span>
          {(lastImport.skipped.length > 0 || lastImport.warnings.length > 0) && (
            <ul>
              {lastImport.skipped.map((s, i) => (
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

      <Main $withPanel={withPanel}>
        {allItems.length === 0 ? (
          <Empty>
            <p>Your library is empty.</p>
            <Muted as="p">
              Drop EPUB, PDF, MOBI, AZW3, CBZ, CBR, TXT or RTF files anywhere on this page, or use “Import files”.
            </Muted>
          </Empty>
        ) : items.length === 0 ? (
          <Empty>
            <Muted>Nothing matches “{query}”.</Muted>
          </Empty>
        ) : view === 'list' ? (
          <LibraryList {...collection} columns={visibleColumns(listColumns, fields)} sort={sort} onSort={setSort} />
        ) : (
          <LibraryGrid {...collection} />
        )}
      </Main>

      {showBulk && <BulkEditor items={selectedItems} onClearSelection={() => setSelection(new Set())} />}
      {showDetail && (
        <ItemDetail
          key={active.id}
          item={active}
          onClose={() => setActiveId(undefined)}
          onSelectTag={(tag) => setQuery(tag)}
          onRead={(file) => setReading({ itemId: active.id, file })}
        />
      )}
      {choosingColumns && (
        <ColumnsDialog
          selected={listColumns}
          fields={fields}
          onChange={setListColumns}
          onClose={() => setChoosingColumns(false)}
        />
      )}
      {dragging && <DropOverlay>Drop files to import</DropOverlay>}
      {reading && readingItem && (
        <Reader key={reading.file.hash} item={readingItem} file={reading.file} onClose={closeReader} />
      )}
    </>
  );
}
