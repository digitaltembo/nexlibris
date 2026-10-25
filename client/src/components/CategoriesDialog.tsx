import {
  type Category,
  createCategory,
  filterItems,
  formatTerm,
  type Operation,
  same,
  userData,
} from '@nexlibris/common';
import { useId, useMemo, useState } from 'react';
import styled from 'styled-components';
import { useLibrary } from '../library/LibraryContext';
import { Button, Muted, Spacer } from '../styles/ui';
import { Modal, ModalFooter } from './Modal';

const CategoryBox = styled.fieldset`
  margin: 16px 0 0;
  padding: 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
`;

const NameRow = styled.div`
  display: flex;
  gap: 8px;

  > input {
    flex: 1;
    min-width: 0;
    font-weight: 600;
  }
`;

const Entries = styled.div`
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1.4fr) auto auto;
  align-items: center;
  gap: 6px 8px;
  margin-top: 10px;

  > input {
    min-width: 0;
  }
`;

const AddEntry = styled(Button)`
  margin-top: 8px;
`;

const ErrorText = styled.p`
  color: var(--danger);
`;

interface Props {
  onClose(): void;
}

const blankEntry = () => ({ label: '', query: '' });

/**
 * The user's own browse categories, as calibre3opds's customization: each a name and named
 * searches. Edits are made to a draft and applied together on Save.
 */
export function CategoriesDialog({ onClose }: Props) {
  const { library, apply } = useLibrary();
  const saved = useMemo(() => Object.values(library.categories ?? {}).sort((a, b) => a.name.localeCompare(b.name)), [library.categories]);
  const [draft, setDraft] = useState<Category[]>(saved);
  const [error, setError] = useState<string>();
  const items = useMemo(() => Object.values(library.items), [library.items]);
  const tagListId = useId();
  const tags = useMemo(
    () => [...new Set(items.flatMap((i) => i.tags))].sort((a, b) => a.localeCompare(b)).map((tag) => formatTerm({ kind: 'field', field: 'tag', values: [tag], negate: false })),
    [items],
  );

  const update = (id: string, change: (category: Category) => Category) => setDraft(draft.map((c) => (c.id === id ? change(c) : c)));
  // Counted again only when a search or the library changes, not on every keystroke in a name.
  const queries = [...new Set(draft.flatMap((c) => c.entries.map((e) => e.query)).filter((q) => q.trim()))].join('\n');
  const counts = useMemo(() => {
    const { ratings } = userData(library);
    return new Map(queries.split('\n').filter((q) => q.trim()).map((q) => [q, filterItems(items, q, { ratings }).length]));
  }, [queries, items, library]);
  const matches = (query: string) => counts.get(query);

  const save = async () => {
    const cleaned = draft.map((c) => ({ ...c, name: c.name.trim(), entries: c.entries.filter((e) => e.query.trim()) }));
    if (cleaned.some((c) => !c.name)) return setError('Each category needs a name.');
    const ops: Operation[] = [
      ...saved.filter((c) => !cleaned.some((d) => d.id === c.id)).map((c): Operation => ({ type: 'removeCategory', id: c.id })),
      ...cleaned
        .filter((c) => !same(c, saved.find((s) => s.id === c.id)))
        .map((category): Operation => ({ type: 'setCategory', category })),
    ];
    try {
      if (ops.length) await apply(ops);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <Modal title="Browse categories" onClose={onClose}>
      <Muted as="p">
        Your own categories, shown in the Library between Series and Tags. Each entry opens the books its search finds
        (say <code>tag:Fantasy</code>); a category with one entry opens its books directly.
      </Muted>
      <datalist id={tagListId}>
        {tags.map((tag) => (
          <option key={tag} value={tag} />
        ))}
      </datalist>
      {draft.map((category) => (
        <CategoryBox key={category.id}>
          <NameRow>
            <input
              aria-label="Category name"
              placeholder="Name, e.g. Moods"
              value={category.name}
              onChange={(e) => update(category.id, (c) => ({ ...c, name: e.target.value }))}
            />
            <Button $variant="secondary" $size="small" onClick={() => setDraft(draft.filter((c) => c.id !== category.id))}>
              Remove
            </Button>
          </NameRow>
          <Entries>
            {category.entries.map((entry, index) => {
              const set = (patch: Partial<typeof entry>) =>
                update(category.id, (c) => ({ ...c, entries: c.entries.map((e, i) => (i === index ? { ...e, ...patch } : e)) }));
              const count = matches(entry.query);
              return [
                <input key={`l${index}`} aria-label="Entry name" placeholder="Name" value={entry.label} onChange={(e) => set({ label: e.target.value })} />,
                <input
                  key={`q${index}`}
                  aria-label="Entry search"
                  placeholder="tag:Fantasy"
                  list={tagListId}
                  value={entry.query}
                  onChange={(e) => set({ query: e.target.value })}
                />,
                <Muted key={`c${index}`}>{count === undefined ? '' : `${count} book${count === 1 ? '' : 's'}`}</Muted>,
                <Button
                  key={`r${index}`}
                  $variant="icon"
                  aria-label={`Remove entry ${entry.label || entry.query}`}
                  onClick={() => update(category.id, (c) => ({ ...c, entries: c.entries.filter((_, i) => i !== index) }))}
                >
                  ×
                </Button>,
              ];
            })}
          </Entries>
          <AddEntry
            $variant="secondary"
            $size="small"
            onClick={() => update(category.id, (c) => ({ ...c, entries: [...c.entries, blankEntry()] }))}
          >
            Add entry
          </AddEntry>
        </CategoryBox>
      ))}
      <p>
        <Button $variant="secondary" onClick={() => setDraft([...draft, createCategory({ name: '', entries: [blankEntry()] })])}>
          New category
        </Button>
      </p>
      {error && <ErrorText>{error}</ErrorText>}
      <ModalFooter>
        <Spacer />
        <Button $variant="secondary" onClick={onClose}>
          Cancel
        </Button>
        <Button onClick={() => void save()}>Save</Button>
      </ModalFooter>
    </Modal>
  );
}
