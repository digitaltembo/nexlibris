import styled from 'styled-components';
import { BUILTIN_COLUMNS, DEFAULT_COLUMNS, fieldColumn, type ColumnId } from '../library/columns';
import { Button, Muted, Spacer } from '../styles/ui';
import { Modal, ModalFooter } from './Modal';

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

interface Props {
  selected: string[];
  /** Metadata fields that can be shown as columns. */
  fields: string[];
  onChange(selected: string[]): void;
  onClose(): void;
}

/** A modal for choosing which columns the list view shows. Changes apply as they're made. */
export function ColumnsDialog({ selected, fields, onChange, onClose }: Props) {
  const toggle = (id: ColumnId, on: boolean) => onChange(on ? [...selected, id] : selected.filter((s) => s !== id));
  const checkbox = (id: ColumnId, text: string) => (
    <label key={id}>
      <input type="checkbox" checked={selected.includes(id)} onChange={(e) => toggle(id, e.target.checked)} />
      {text}
    </label>
  );

  return (
    <Modal title="Columns" onClose={onClose}>
      <Muted as="p">Title is always shown.</Muted>
      <Group>
        <legend>Library</legend>
        <Options>{BUILTIN_COLUMNS.map((c) => checkbox(c.id, c.label))}</Options>
      </Group>
      {fields.length > 0 && (
        <Group>
          <legend>Fields</legend>
          <Options>{fields.map((key) => checkbox(fieldColumn(key), key))}</Options>
        </Group>
      )}
      <ModalFooter>
        <Button $variant="secondary" onClick={() => onChange(DEFAULT_COLUMNS)}>
          Reset to default
        </Button>
        <Spacer />
        <Button onClick={onClose}>Done</Button>
      </ModalFooter>
    </Modal>
  );
}
