import { useEffect, useRef } from 'react';
import styled from 'styled-components';
import { BUILTIN_COLUMNS, DEFAULT_COLUMNS, fieldColumn, type ColumnId } from '../library/columns';
import { Button, Muted, Spacer } from '../styles/ui';

const Dialog = styled.dialog`
  width: min(480px, calc(100vw - 32px));
  max-height: calc(100vh - 64px);
  padding: 0;
  border: 1px solid var(--border);
  border-radius: 12px;
  background: var(--surface);
  color: var(--text);
  box-shadow: 0 12px 40px rgb(0 0 0 / 0.25);

  &::backdrop {
    background: rgb(0 0 0 / 0.35);
  }
`;

const Body = styled.div`
  padding: 20px;

  h2 {
    margin: 0;
    font-size: 1.15rem;
  }
`;

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

const Footer = styled.footer`
  display: flex;
  gap: 8px;
  margin-top: 20px;
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
  const ref = useRef<HTMLDialogElement>(null);

  // No close() on cleanup: it fires `close`, which would call onClose when StrictMode
  // re-runs this effect. Unmounting removes the dialog, which ends the modal anyway.
  useEffect(() => {
    if (!ref.current?.open) ref.current?.showModal();
  }, []);

  const toggle = (id: ColumnId, on: boolean) => onChange(on ? [...selected, id] : selected.filter((s) => s !== id));
  const checkbox = (id: ColumnId, text: string) => (
    <label key={id}>
      <input type="checkbox" checked={selected.includes(id)} onChange={(e) => toggle(id, e.target.checked)} />
      {text}
    </label>
  );

  return (
    <Dialog
      ref={ref}
      aria-labelledby="columns-title"
      onClose={onClose}
      // A click on the dialog element itself (not its contents) is a click on the backdrop.
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <Body>
        <h2 id="columns-title">Columns</h2>
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
        <Footer>
          <Button $variant="secondary" onClick={() => onChange(DEFAULT_COLUMNS)}>
            Reset to default
          </Button>
          <Spacer />
          <Button onClick={onClose}>Done</Button>
        </Footer>
      </Body>
    </Dialog>
  );
}
