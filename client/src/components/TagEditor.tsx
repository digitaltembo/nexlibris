import { useMemo, useState } from 'react';
import styled from 'styled-components';
import { useLibrary } from '../library/LibraryContext';
import { tagsIn } from '../library/completion';
import { Tag, TagLabel, TagList, TagRemove } from '../styles/ui';
import { CompletionInput } from './CompletionInput';
import { t } from '../i18n';

interface Props {
  tags: string[];
  onAdd(tags: string[]): void;
  onRemove(tag: string): void;
  /** What's completed, and with `only`, all that can be added; the library's tags if not given. */
  candidates?: string[];
  /** Accepts only `candidates`, dropping anything else typed. */
  only?: boolean;
  /** What a chip is and what several are, for the placeholder and labels ("tag" and "tags" if not given). */
  noun?: { one: string; many: string };
}

const TagInput = styled(CompletionInput)`
  flex: 1 1 120px;
`;

/**
 * Tags as removable chips, with an input that adds comma-separated tags on Enter, completing them
 * from the library's other tags (a picked one is added straight away). Other lists of chips, such
 * as a connection's formats, use it with their own `candidates`.
 */
export function TagEditor({ tags, onAdd, onRemove, candidates: given, only, noun = { one: t('tagEditor.tag'), many: t('tagEditor.tags') } }: Props) {
  const { library } = useLibrary();
  const [draft, setDraft] = useState('');
  const libraryTags = useMemo(() => (given ? [] : tagsIn(Object.values(library.items))), [given, library.items]);
  const candidates = given ?? libraryTags;

  const add = (text = draft) => {
    const typed = text.split(',').map((t) => t.trim()).filter(Boolean);
    const added = only ? typed.flatMap((t) => candidates.filter((c) => c.toLowerCase() === t.toLowerCase())) : typed;
    if (added.length) onAdd(added);
    setDraft('');
  };

  return (
    <TagList>
      {tags.map((tag) => (
        <Tag key={tag}>
          <TagLabel>{tag}</TagLabel>
          <TagRemove aria-label={t('tagEditor.remove', { noun: noun.one, tag })} onClick={() => onRemove(tag)}>
            ×
          </TagRemove>
        </Tag>
      ))}
      <TagInput
        placeholder={tags.length ? t('tagEditor.addOne', { noun: noun.one }) : t('tagEditor.addMany', { nouns: noun.many })}
        aria-label={t('tagEditor.addLabel', { nouns: noun.many })}
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
