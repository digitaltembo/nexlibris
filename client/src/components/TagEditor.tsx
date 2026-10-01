import { useState } from 'react';
import styled from 'styled-components';
import { Tag, TagLabel, TagList, TagRemove } from '../styles/ui';

interface Props {
  tags: string[];
  onAdd(tags: string[]): void;
  onRemove(tag: string): void;
}

const TagInput = styled.input`
  flex: 1 1 120px;
`;

/** Tags as removable chips, with an input that adds comma-separated tags on Enter. */
export function TagEditor({ tags, onAdd, onRemove }: Props) {
  const [draft, setDraft] = useState('');

  const add = () => {
    const added = draft.split(',').map((t) => t.trim()).filter(Boolean);
    if (added.length) onAdd(added);
    setDraft('');
  };

  return (
    <TagList>
      {tags.map((tag) => (
        <Tag key={tag}>
          <TagLabel>{tag}</TagLabel>
          <TagRemove aria-label={`Remove tag ${tag}`} onClick={() => onRemove(tag)}>
            ×
          </TagRemove>
        </Tag>
      ))}
      <TagInput
        placeholder={tags.length ? 'Add tag…' : 'Add tags, comma-separated…'}
        aria-label="Add tags"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={add}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            add();
          }
          if (e.key === 'Backspace' && !draft && tags.length) onRemove(tags[tags.length - 1]!);
        }}
      />
    </TagList>
  );
}
