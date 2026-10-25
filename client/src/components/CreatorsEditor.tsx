import type { Creator } from '@nexlibris/common';
import { useState } from 'react';
import { Button, Row, Stack } from '../styles/ui';
import { ROLES } from '../library/roles';
import { t } from '../i18n';

interface Props {
  creators: Creator[];
  onChange(creators: Creator[]): void;
}

export function CreatorsEditor({ creators, onChange }: Props) {
  const [newName, setNewName] = useState('');
  const update = (index: number, creator: Creator | undefined) =>
    onChange(creator ? creators.map((c, i) => (i === index ? creator : c)) : creators.filter((_, i) => i !== index));
  const add = () => {
    if (!newName.trim()) return;
    onChange([...creators, { name: newName.trim(), role: 'aut' }]);
    setNewName('');
  };

  return (
    <Stack>
      {creators.map((creator, i) => (
        <Row key={i}>
          <input value={creator.name} aria-label={t('creatorsEditor.name')} onChange={(e) => update(i, { ...creator, name: e.target.value })} />
          <select value={creator.role} aria-label={t('creatorsEditor.role')} onChange={(e) => update(i, { ...creator, role: e.target.value })}>
            {Object.entries(ROLES).map(([code, label]) => (
              <option key={code} value={code}>
                {label}
              </option>
            ))}
            {!(creator.role in ROLES) && <option value={creator.role}>{creator.role}</option>}
          </select>
          <Button $variant="icon" aria-label={t('creatorsEditor.remove', { name: creator.name })} onClick={() => update(i, undefined)}>
            ×
          </Button>
        </Row>
      ))}
      <input
        placeholder={t('creatorsEditor.add')}
        value={newName}
        onChange={(e) => setNewName(e.target.value)}
        onBlur={add}
        onKeyDown={(e) => e.key === 'Enter' && add()}
      />
    </Stack>
  );
}
