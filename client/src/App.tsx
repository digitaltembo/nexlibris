import { createItem, userData, type FileRef, type Item, type ItemId } from '@nexlibris/common';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import styled from 'styled-components';
import { BulkEditor } from './components/BulkEditor';
import { BackupDialog } from './components/BackupDialog';
import { DevicesDialog } from './components/DevicesDialog';
import { ColumnsDialog } from './components/ColumnsDialog';
import { FiltersDialog } from './components/FiltersDialog';
import { IsbnDialog } from './components/IsbnDialog';
import { ItemDetail } from './components/ItemDetail';
import { LibraryGrid, type CollectionProps } from './components/LibraryGrid';
import { LibraryList } from './components/LibraryList';
import { IMPORT_ACCEPT } from './formats/formats';
import { availableFields, DEFAULT_COLUMNS, visibleColumns } from './library/columns';
import { describeRule, filterFields, filtersQuery, parseFilters } from './library/filters';
import { importFiles, type ImportResult, type ImportSource } from './library/importFiles';
import { nativeImportAvailable, pickNativeFiles } from './library/nativeImport';
import { useBackToClose } from './library/useBackToClose';
import { useLibrary } from './library/LibraryContext';
import { DEFAULT_DESC, filterItems, sortItems, type Sort, type SortKey } from './library/search';
import { usePersistentState } from './library/usePersistentState';
import { Reader } from './reader/Reader';
import { besidePanel, Button, FileButton, Muted, Tag, TagButton, TagLabel, TagList, TagRemove } from './styles/ui';

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

const FilterChips = styled(TagList)`
  flex: 1;
`;

/** A chip's label that opens the filters. */
const ChipLabel = styled(TagLabel).attrs({ as: 'button', type: 'button' })`
  border: none;
  background: none;
  color: var(--text);
  font: inherit;
  cursor: pointer;
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
    background: var(--highlight);
    color: var(--highlight-text);
    border-color: var(--highlight);
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
  background: var(--soft);
  border-left: 4px solid var(--highlight);
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
  /** The filters' rules, as search text (`library/filters.ts`); applied along with `query`. */
  const [filterQuery, setFilterQuery] = useState('');
  const [editingFilters, setEditingFilters] = useState(false);
  const [view, setView] = usePersistentState<View>('nexlibris:view', 'grid');
  const [sort, setSort] = usePersistentState<Sort>('nexlibris:sort', {
    key: 'title',
    desc: false,
  });
  const [listColumns, setListColumns] = usePersistentState<string[]>('nexlibris:listColumns', DEFAULT_COLUMNS);
  const [choosingColumns, setChoosingColumns] = useState(false);
  const [backingUp, setBackingUp] = useState(false);
  const [managingDevices, setManagingDevices] = useState(false);
  const [addingByIsbn, setAddingByIsbn] = useState(false);
  const [activeId, setActiveId] = useState<ItemId>();
  const [selecting, setSelecting] = useState(false);
  const [selection, setSelection] = useState<ReadonlySet<ItemId>>(new Set());
  const anchorRef = useRef<ItemId>(undefined);
  /** Files done and total, while an import runs. */
  const [importing, setImporting] = useState<{ done: number; total: number }>();
  const [lastImport, setLastImport] = useState<ImportResult>();
  const [dragging, setDragging] = useState(false);
  const [reading, setReading] = useState<{ itemId: ItemId; file: FileRef }>();

  const allItems = Object.values(library.items);
  const { ratings } = userData(library);
  const items = useMemo(() => {
    const context = { ratings };
    const filtered = filterItems(filterItems(Object.values(library.items), filterQuery, context), query, context);
    return sortItems(filtered, sort, ratings);
  }, [library.items, filterQuery, query, sort, ratings]);
  const countMatches = (q: string) => filterItems(filterItems(allItems, q, { ratings }), query, { ratings }).length;
  const filterFieldList = useMemo(() => filterFields(Object.values(library.items)), [library.items]);
  const filters = filterQuery ? parseFilters(filterQuery, filterFieldList) : undefined;
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

  // Back closes these, innermost (registered last) first.
  useBackToClose(selecting, stopSelecting);
  useBackToClose(showDetail, () => setActiveId(undefined));
  useBackToClose(choosingColumns, () => setChoosingColumns(false));
  useBackToClose(backingUp, () => setBackingUp(false));
  useBackToClose(managingDevices, () => setManagingDevices(false));
  useBackToClose(editingFilters, () => setEditingFilters(false));
  useBackToClose(reading !== undefined, closeReader);

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

  const runImport = async (files: ImportSource[], skipped: ImportResult['skipped'] = []) => {
    if (!files.length && !skipped.length) return;
    setImporting({ done: 0, total: files.length });
    try {
      const result = await importFiles(backend, files, {
        onProgress: (done, total) => setImporting({ done, total }),
        onSaved: () => void refresh(),
      });
      result.skipped.unshift(...skipped);
      setLastImport(result);
      await refresh();
      const touched = [...result.added, ...result.merged.map((m) => m.item)];
      if (touched.length === 1 && !selecting) setActiveId(touched[0]!.id);
    } finally {
      setImporting(undefined);
    }
  };

  const [pickingFiles, setPickingFiles] = useState(false);
  const importLabel = importing ? `Importing ${importing.done}/${importing.total}…` : 'Import files';
  /** In the Android and desktop apps: the native picker, which stores the files itself (much faster on Android). */
  const importNatively = async () => {
    setPickingFiles(true);
    let picked;
    try {
      picked = await pickNativeFiles();
    } catch (e) {
      setLastImport({ added: [], merged: [], skipped: [{ name: 'Import', reason: e instanceof Error ? e.message : String(e) }], warnings: [] });
      return;
    } finally {
      setPickingFiles(false);
    }
    if (picked) await runImport(picked.files, picked.skipped);
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
  const overlayOpen = reading !== undefined || choosingColumns || backingUp || managingDevices;

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
          placeholder={`Search ${allItems.length} ${allItems.length === 1 ? 'item' : 'items'}…`}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <Button $variant="secondary" aria-pressed={!!filterQuery} onClick={() => setEditingFilters(true)}>
          {filters?.rules.length ? `Filters (${filters.rules.length})` : 'Filters…'}
        </Button>
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
            {nativeImportAvailable() ? (
              <Button disabled={importing !== undefined || pickingFiles} onClick={() => void importNatively()}>
                {pickingFiles ? 'Copying files…' : importLabel}
              </Button>
            ) : (
              <FileButton>
                {importLabel}
                <input
                  type="file"
                  accept={IMPORT_ACCEPT}
                  multiple
                  hidden
                  disabled={importing !== undefined}
                  onChange={(e) => {
                    void runImport(Array.from(e.target.files ?? []));
                    e.target.value = '';
                  }}
                />
              </FileButton>
            )}
            <Button $variant="secondary" onClick={() => void addBlankItem()}>
              New item
            </Button>
            <Button $variant="secondary" onClick={() => setAddingByIsbn(true)}>
              Add by ISBN…
            </Button>
            <Button $variant="secondary" onClick={() => setManagingDevices(true)}>
              Devices…
            </Button>
            <Button $variant="secondary" onClick={() => setBackingUp(true)}>
              Backup…
            </Button>
          </>
        )}
      </Toolbar>

      {filterQuery && (
        <Notice $withPanel={withPanel} role="status" aria-label="Filters">
          <FilterChips>
            {filters && filters.any && filters.rules.length > 1 && <Muted>Any of:</Muted>}
            {filters ? (
              filters.rules.map((rule, index) => (
                <Tag key={index}>
                  <ChipLabel onClick={() => setEditingFilters(true)}>{describeRule(rule, filterFieldList)}</ChipLabel>
                  <TagRemove
                    aria-label={`Remove filter: ${describeRule(rule, filterFieldList)}`}
                    onClick={() => setFilterQuery(filtersQuery({ ...filters, rules: filters.rules.filter((_, i) => i !== index) }))}
                  >
                    ×
                  </TagRemove>
                </Tag>
              ))
            ) : (
              <TagButton onClick={() => setEditingFilters(true)}>{filterQuery}</TagButton>
            )}
          </FilterChips>
          <Button $variant="secondary" $size="small" onClick={() => setFilterQuery('')}>
            Clear filters
          </Button>
        </Notice>
      )}

      {selecting && selectedItems.length === 0 && (
        <Notice $withPanel={withPanel} role="status">
          <Muted>Click items to select them. Shift-click selects a range.</Muted>
        </Notice>
      )}

      {lastImport && (
        <Notice $withPanel={withPanel} role="status">
          <span>
            Imported {lastImport.added.length} item{lastImport.added.length === 1 ? '' : 's'}
            {lastImport.merged.length > 0 &&
              `, and added files to ${lastImport.merged.length} book${lastImport.merged.length === 1 ? '' : 's'} already in the library`}
            {lastImport.skipped.length > 0 && `, skipped ${lastImport.skipped.length}`}.
          </span>
          {(lastImport.merged.length > 0 || lastImport.skipped.length > 0 || lastImport.warnings.length > 0) && (
            <ul>
              {lastImport.merged.map((m) => (
                <li key={`m${m.item.id}`}>
                  {m.names.join(', ')}: added to “{m.item.title}”
                </li>
              ))}
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
            <Muted>{query ? `Nothing matches “${query}”${filterQuery ? ' with these filters' : ''}.` : 'Nothing matches these filters.'}</Muted>
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
          onSelectTag={(tag) => {
            setQuery('');
            setFilterQuery(filtersQuery({ any: false, rules: [{ field: 'tag', condition: 'anyOf', values: [tag] }] }));
          }}
          onRead={(file) => setReading({ itemId: active.id, file })}
        />
      )}
      {backingUp && <BackupDialog onClose={() => setBackingUp(false)} />}
      {managingDevices && <DevicesDialog onClose={() => setManagingDevices(false)} />}
      {editingFilters && (
        <FiltersDialog
          title="Filters"
          query={filterQuery}
          onChange={setFilterQuery}
          onClose={() => setEditingFilters(false)}
          items={allItems}
          count={countMatches}
        />
      )}
      {addingByIsbn && (
        <IsbnDialog
          onClose={() => setAddingByIsbn(false)}
          onOpen={(id) => {
            setAddingByIsbn(false);
            stopSelecting();
            setActiveId(id);
          }}
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
