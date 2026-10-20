import { useMemo, useState } from 'react';
import styled from 'styled-components';
import { useLibrary } from '../library/LibraryContext';
import { tagsIn } from '../library/completion';
import { Tag, TagLabel, TagList, TagRemove } from '../styles/ui';
import { CompletionInput } from './CompletionInput';

interface Props {
  tags: string[];
  onAdd(tags: string[]): void;
  onRemove(tag: string): void;
}

const TagInput = styled(CompletionInput)`
  flex: 1 1 120px;
`;

/**
 * Tags as removable chips, with an input that adds comma-separated tags on Enter, completing them
 * from the library's other tags (a picked one is added straight away).
 */
export function TagEditor({ tags, onAdd, onRemove }: Props) {
  const { library } = useLibrary();
  const [draft, setDraft] = useState('');
  const candidates = useMemo(() => tagsIn(Object.values(library.items)), [library.items]);

  const add = (text = draft) => {
    const added = text.split(',').map((t) => t.trim()).filter(Boolean);
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
        candidates={candidates}
        exclude={tags}
        onChange={setDraft}
        onPick={add}
        onBlur={() => add()}
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
