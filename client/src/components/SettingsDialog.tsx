import styled from 'styled-components';
import { fieldLabel } from '../library/bookFields';
import { BUILTIN_COLUMNS, DEFAULT_COLUMNS, fieldColumn, type ColumnId } from '../library/columns';
import { DEFAULT_DESC, type Sort, type SortKey } from '../library/search';
import { Button, Muted, Spacer } from '../styles/ui';
import { Modal, ModalFooter } from './Modal';
import { VIEWS, type View } from '../views/views';

export type { View } from '../views/views';

export const SORT_LABELS: Record<SortKey, string> = {
  title: 'Title',
  author: 'Author',
  series: 'Series',
  published: 'First published',
  rating: 'Rating',
  size: 'Size',
  added: 'Date added',
};

const Group = styled.fieldset`
  margin: 16px 0 0;
  padding: 0;
  border: none;

  legend {
    margin-bottom: 6px;
    padding: 0;
    font-size: 0.8rem;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--muted);
  }
`;

const Options = styled.div`
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
  gap: 4px 16px;

  label {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 2px 0;
    overflow-wrap: anywhere;
    cursor: pointer;
  }
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

  > button + button {
    border-left: none;
  }

  > button:last-child {
    border-radius: 0 var(--radius) var(--radius) 0;
  }

  > button[aria-pressed='true'] {
    background: var(--highlight);
    color: var(--highlight-text);
    border-color: var(--highlight);
    font-weight: 600;
  }
`;

const SortRow = styled.div`
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
`;

interface Props {
  view: View;
  onView(view: View): void;
  sort: Sort;
  onSort(sort: Sort): void;
  /** The list view's columns. */
  columns: string[];
  /** Metadata fields that can be shown as columns. */
  fields: string[];
  onColumns(columns: string[]): void;
  onClose(): void;
}

/** How the library is shown: grid or list, the sort, and the list's columns. Changes apply as they're made. */
export function SettingsDialog({ view, onView, sort, onSort, columns, fields, onColumns, onClose }: Props) {
  const toggle = (id: ColumnId, on: boolean) => onColumns(on ? [...columns, id] : columns.filter((s) => s !== id));
  const checkbox = (id: ColumnId, text: string) => (
    <label key={id}>
      <input type="checkbox" checked={columns.includes(id)} onChange={(e) => toggle(id, e.target.checked)} />
      {text}
    </label>
  );

  return (
    <Modal title="Settings" onClose={onClose}>
      <Group>
        <legend>View</legend>
        <Segmented role="group" aria-label="View">
          {VIEWS.map((v) => (
            <button key={v.id} type="button" aria-pressed={view === v.id} onClick={() => onView(v.id)}>
              {v.label}
            </button>
          ))}
        </Segmented>
      </Group>
      <Group>
        <legend>Sort</legend>
        <SortRow>
          <select
            value={sort.key}
            aria-label="Sort by"
            onChange={(e) => {
              const key = e.target.value as SortKey;
              onSort({ key, desc: DEFAULT_DESC[key] });
            }}
          >
            {Object.entries(SORT_LABELS).map(([key, label]) => (
              <option key={key} value={key}>
                {label}
              </option>
            ))}
          </select>
          <label>
            <input type="checkbox" checked={sort.desc} onChange={(e) => onSort({ ...sort, desc: e.target.checked })} /> Descending
          </label>
        </SortRow>
        {view === 'list' && <Muted as="p">The list’s column headers sort too.</Muted>}
      </Group>
      <Group>
        <legend>List columns</legend>
        <Muted as="p">Title is always shown.</Muted>
        <Options>{BUILTIN_COLUMNS.map((c) => checkbox(c.id, c.label))}</Options>
        {fields.length > 0 && (
          <>
            <Muted as="p">Fields</Muted>
            <Options>{fields.map((key) => checkbox(fieldColumn(key), fieldLabel(key)))}</Options>
          </>
        )}
      </Group>
      <ModalFooter>
        <Button $variant="secondary" onClick={() => onColumns(DEFAULT_COLUMNS)}>
          Reset columns
        </Button>
        <Spacer />
        <Button onClick={onClose}>Done</Button>
      </ModalFooter>
    </Modal>
  );
}
