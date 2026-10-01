import { userData, type Item } from '@nexlibris/common';
import type { ReactNode } from 'react';
import styled, { css } from 'styled-components';
import { BUILTIN_COLUMNS, fieldKey, type BuiltinColumn, type ColumnId } from '../library/columns';
import { useLibrary } from '../library/LibraryContext';
import { metadataToText } from '../library/metadataText';
import { DEFAULT_DESC, type Sort, type SortKey } from '../library/search';
import { Cover, PlaceholderTitle } from './Cover';
import { formatLabel } from './ItemFiles';
import { seriesLabel } from './ItemDetail';
import { clickModifiers, type CollectionProps } from './LibraryGrid';
import { StarRating } from './StarRating';
import { NARROW } from '../styles/GlobalStyle';
import { Badge } from '../styles/ui';

/** A column's kind: built-in columns by id, metadata fields all alike. */
type ColumnKind = BuiltinColumn | 'title' | 'check' | 'field';

const columnStyles: Partial<Record<ColumnKind, ReturnType<typeof css>>> = {
  check: css`
    width: 28px;
  `,
  cover: css`
    width: 40px;
  `,
  title: css`
    font-weight: 500;
  `,
  series: css`
    color: var(--muted);
  `,
  tags: css`
    color: var(--muted);
  `,
  rating: css`
    white-space: nowrap;
  `,
  added: css`
    white-space: nowrap;
  `,
  updated: css`
    white-space: nowrap;
  `,
  field: css`
    max-width: 16em;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--muted);
  `,
};

/** Dropped on narrow screens to leave room for the title. */
const NARROW_HIDDEN = new Set<ColumnKind>(['series', 'tags', 'formats', 'added', 'updated', 'field']);

const cellStyles = css<{ $col: ColumnKind }>`
  ${(p) => columnStyles[p.$col]}

  ${NARROW} {
    ${(p) => NARROW_HIDDEN.has(p.$col) && 'display: none;'}
  }
`;

const Table = styled.table<{ $selecting: boolean }>`
  width: 100%;
  border-collapse: collapse;
  font-size: 0.93rem;
  ${(p) => p.$selecting && 'user-select: none;'}
`;

const Th = styled.th<{ $col: ColumnKind }>`
  position: sticky;
  top: 54px;
  padding: 6px 8px;
  background: var(--bg);
  border-bottom: 1px solid var(--border);
  text-align: left;
  font-size: 0.85em;
  font-weight: 600;
  color: var(--muted);
  white-space: nowrap;
  ${cellStyles}
`;

const Td = styled.td<{ $col: ColumnKind }>`
  padding: 4px 8px;
  border-bottom: 1px solid var(--border);
  vertical-align: middle;
  ${cellStyles}
`;

const Tr = styled.tr<{ $highlighted: boolean }>`
  cursor: pointer;
  ${(p) => p.$highlighted && 'background: var(--soft);'}

  &:hover {
    ${(p) => !p.$highlighted && 'background: var(--hover);'}
  }
`;

const SortHeader = styled.button.attrs({ type: 'button' })`
  padding: 0;
  border: none;
  background: none;
  color: inherit;
  font-weight: inherit;

  &:hover {
    color: var(--text);
  }
`;

const Thumbnail = styled(Cover)`
  width: 28px;
  box-shadow: none;

  ${PlaceholderTitle} {
    display: none;
  }
`;

interface Props extends CollectionProps {
  /** Visible columns besides the title, from `visibleColumns`. */
  columns: ColumnId[];
  sort: Sort;
  onSort(sort: Sort): void;
}

const formats = (item: Item) => [...new Set(item.files.map((f) => formatLabel(f.format)))];
const date = (iso: string) => new Date(iso).toLocaleDateString();

export function LibraryList({ items, activeId, selecting, selection, onActivate, columns: visible, sort, onSort }: Props) {
  const { library } = useLibrary();
  const { ratings } = userData(library);
  // The thumbnail sits before the title; everything else follows it.
  const showCover = visible.includes('cover');
  const columns = visible.filter((id) => id !== 'cover');

  const builtinCell: Record<BuiltinColumn, (item: Item) => ReactNode> = {
    cover: () => null,
    creators: (item) => item.creators.map((c) => c.name).join(', '),
    series: (item) => seriesLabel(item),
    tags: (item) => item.tags.join(', '),
    rating: (item) => <StarRating value={ratings[item.id]} />,
    formats: (item) =>
      formats(item).map((f) => (
        <Badge key={f}>{f}</Badge>
      )),
    added: (item) => date(item.addedAt),
    updated: (item) => date(item.updatedAt),
  };

  const cell = (id: ColumnId, item: Item) => {
    const key = fieldKey(id);
    if (key === undefined) return builtinCell[id as BuiltinColumn](item);
    const value = item.metadata[key];
    return value === undefined || value === null ? null : metadataToText(value);
  };

  const label = (id: ColumnId) => fieldKey(id) ?? BUILTIN_COLUMNS.find((c) => c.id === id)!.label;
  const kind = (id: ColumnId): ColumnKind => (fieldKey(id) === undefined ? (id as BuiltinColumn) : 'field');

  const header = (key: SortKey | undefined, text: string) => {
    if (!key) return text;
    const active = sort.key === key;
    return (
      <SortHeader
        onClick={() => onSort(active ? { key, desc: !sort.desc } : { key, desc: DEFAULT_DESC[key] })}
      >
        {text}
        {active && <span aria-hidden>{sort.desc ? ' ↓' : ' ↑'}</span>}
      </SortHeader>
    );
  };

  const sortKey = (id: ColumnId) => BUILTIN_COLUMNS.find((c) => c.id === id)?.sort;
  const ariaSort = (key: SortKey | undefined) =>
    key && sort.key === key ? (sort.desc ? 'descending' : 'ascending') : undefined;

  return (
    <Table $selecting={selecting}>
      <thead>
        <tr>
          {selecting && <Th $col="check" aria-label="Selected" />}
          {showCover && <Th $col="cover" aria-label="Cover" />}
          <Th $col="title" aria-sort={ariaSort('title')}>
            {header('title', 'Title')}
          </Th>
          {columns.map((id) => (
            <Th key={id} $col={kind(id)} aria-sort={ariaSort(sortKey(id))}>
              {header(sortKey(id), label(id))}
            </Th>
          ))}
        </tr>
      </thead>
      <tbody>
        {items.map((item) => {
          const isSelected = selection.has(item.id);
          return (
            <Tr
              key={item.id}
              $highlighted={isSelected || (item.id === activeId && !selecting)}
              tabIndex={0}
              aria-selected={selecting ? isSelected : undefined}
              onClick={(e) => onActivate(item.id, clickModifiers(e))}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  onActivate(item.id, { shiftKey: e.shiftKey, metaKey: e.metaKey, ctrlKey: e.ctrlKey });
                }
              }}
            >
              {selecting && (
                <Td $col="check">
                  <input type="checkbox" checked={isSelected} readOnly tabIndex={-1} aria-label={`Select ${item.title}`} />
                </Td>
              )}
              {showCover && (
                <Td $col="cover">
                  <Thumbnail item={item} />
                </Td>
              )}
              <Td $col="title">{item.title}</Td>
              {columns.map((id) => (
                <Td key={id} $col={kind(id)}>
                  {cell(id, item)}
                </Td>
              ))}
            </Tr>
          );
        })}
      </tbody>
    </Table>
  );
}
