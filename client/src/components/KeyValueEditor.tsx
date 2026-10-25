import { useState } from 'react';
import styled from 'styled-components';
import { Button, Row, Stack } from '../styles/ui';
import { t } from '../i18n';

const Key = styled.span`
  flex: 0 0 110px;
  overflow: hidden;
  text-overflow: ellipsis;
  color: var(--muted);
  font-size: 0.9em;
`;

interface Props {
  entries: [key: string, value: string][];
  onChange(entries: [string, string][]): void;
  keyPlaceholder: string;
}

/** Editable key/value rows with a row for adding a new key. */
export function KeyValueEditor({ entries, onChange, keyPlaceholder }: Props) {
  const [newKey, setNewKey] = useState('');
  const [newValue, setNewValue] = useState('');
  const trimmedKey = newKey.trim();
  const canAdd = trimmedKey !== '' && !entries.some(([key]) => key === trimmedKey);

  const add = () => {
    if (!canAdd) return;
    onChange([...entries, [trimmedKey, newValue]]);
    setNewKey('');
    setNewValue('');
  };

  return (
    <Stack>
      {entries.map(([key, value], i) => (
        <Row key={key}>
          <Key>{key}</Key>
          <input
            value={value}
            aria-label={key}
            onChange={(e) => onChange(entries.map((entry, j) => (j === i ? [key, e.target.value] : entry)))}
          />
          <Button
            $variant="icon"
            aria-label={t('keyValueEditor.remove', { key })}
            onClick={() => onChange(entries.filter((_, j) => j !== i))}
          >
            ×
          </Button>
        </Row>
      ))}
      <Row>
        <input
          placeholder={keyPlaceholder}
          value={newKey}
          onChange={(e) => setNewKey(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && add()}
        />
        <input
          placeholder={t('keyValueEditor.value')}
          value={newValue}
          onChange={(e) => setNewValue(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && add()}
        />
        <Button $variant="icon" aria-label={t('keyValueEditor.add')} disabled={!canAdd} onClick={add}>
          +
        </Button>
      </Row>
    </Stack>
  );
}
