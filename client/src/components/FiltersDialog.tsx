import type { Item } from '@nexlibris/common';
import { useId, useMemo, useState, type KeyboardEvent } from 'react';
import styled from 'styled-components';
import {
  CONDITIONS,
  conditionLabel,
  fieldById,
  fieldSuggestions,
  filterFields,
  filtersQuery,
  parseFilters,
  type Condition,
  type FilterField,
  type Filters,
  type Rule,
} from '../library/filters';
import { Button, Muted, Spacer, Tag, TagLabel, TagList, TagRemove } from '../styles/ui';
import { Modal, ModalFooter } from './Modal';

const Rules = styled.ol`
  list-style: none;
  margin: 16px 0 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 10px;
`;

/** Field, condition and remove on one line; the value below, full width. */
const RuleRow = styled.li`
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) auto;
  gap: 6px;
  align-items: center;
  padding-bottom: 10px;
  border-bottom: 1px solid var(--border);
`;

const Value = styled.div`
  grid-column: 1 / -1;
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  align-items: center;
  min-width: 0;

  &:empty {
    display: none;
  }

  > input {
    flex: 1 1 120px;
    min-width: 0;
  }

  > input[type='number'] {
    flex: 0 1 90px;
  }
`;

const MatchLine = styled.p`
  margin: 16px 0 0;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
`;

const Raw = styled.textarea`
  width: 100%;
  margin-top: 12px;
  min-height: 4em;
  font: inherit;
`;

const DATE_UNITS = ['days', 'weeks', 'months', 'years'] as const;

/** The values a new condition starts with, so a rule filters something as soon as it's made where it can. */
function defaultValues(field: FilterField, condition: Condition): string[] {
  if (condition === 'inLast') return ['30 days'];
  if (field.kind === 'rating' && condition !== 'present' && condition !== 'absent') return ['4'];
  return [];
}

const conditionsFor = (field: FilterField) =>
  // "Anything is empty" means nothing.
  field.id === 'text' ? CONDITIONS.text.filter((c) => c !== 'present' && c !== 'absent') : CONDITIONS[field.kind];

interface Props {
  title: string;
  /** What the rules are for, above them. */
  intro?: string;
  /** The rules as search text (see `library/search.ts`). */
  query: string;
  onChange(query: string): void;
  onClose(): void;
  items: Item[];
  /** How many items a query matches, to show as rules change. */
  count(query: string): number;
}

/**
 * Filters as rules, like a smart playlist: "Tags is any of Fantasy", "Rating is at least 4".
 * Each change applies straight away. Search text that rules can't show (typed by hand) is
 * offered as text instead.
 */
export function FiltersDialog({ title, intro, query, onChange, onClose, items, count }: Props) {
  const fields = useMemo(() => filterFields(items), [items]);
  // Kept here rather than re-read from `query`, so a rule still being filled in (no value yet) stays.
  const [filters, setFilters] = useState<Filters | undefined>(() => parseFilters(query, fields));
  const [raw, setRaw] = useState(query);
  const matchId = useId();

  const update = (next: Filters) => {
    setFilters(next);
    onChange(filtersQuery(next));
  };
  const updateRule = (index: number, rule: Rule) =>
    filters && update({ ...filters, rules: filters.rules.map((r, i) => (i === index ? rule : r)) });

  const addRule = () => {
    const field = fieldById(fields, 'tag');
    const condition = conditionsFor(field)[0]!;
    const current = filters ?? { rules: [], any: false };
    update({ ...current, rules: [...current.rules, { field: field.id, condition, values: defaultValues(field, condition) }] });
  };

  const matches = count(filters ? filtersQuery(filters) : raw);

  return (
    <Modal title={title} onClose={onClose}>
      {intro && <Muted as="p">{intro}</Muted>}

      {!filters ? (
        <>
          <Muted as="p">
            This search uses terms the rules can’t show (such as a quoted phrase, or “or” mixed with other terms). Edit it
            as text, or start again with rules.
          </Muted>
          <Raw
            aria-label="Search"
            value={raw}
            onChange={(e) => {
              setRaw(e.target.value);
              onChange(e.target.value);
            }}
          />
        </>
      ) : (
        <>
          {filters.rules.length > 1 && (
            <MatchLine>
              <label htmlFor={matchId}>Match</label>
              <select
                id={matchId}
                value={filters.any ? 'any' : 'all'}
                onChange={(e) => update({ ...filters, any: e.target.value === 'any' })}
              >
                <option value="all">all</option>
                <option value="any">any</option>
              </select>
              <span>of these rules</span>
            </MatchLine>
          )}
          {filters.rules.length === 0 && (
            <Muted as="p">No rules yet. Add one to narrow the books down by author, tag, rating, format and more.</Muted>
          )}
          <Rules>
            {filters.rules.map((rule, index) => (
              <RuleEditor
                key={index}
                rule={rule}
                fields={fields}
                items={items}
                onChange={(next) => updateRule(index, next)}
                onRemove={() => update({ ...filters, rules: filters.rules.filter((_, i) => i !== index) })}
              />
            ))}
          </Rules>
        </>
      )}

      <MatchLine>
        <Muted>
          {matches} {matches === 1 ? 'book matches' : 'books match'}.
        </Muted>
      </MatchLine>

      <ModalFooter>
        <Button $variant="secondary" onClick={addRule}>
          Add rule
        </Button>
        {(filters ? filters.rules.length > 0 : raw.trim()) && (
          <Button
            $variant="secondary"
            onClick={() => {
              setRaw('');
              update({ rules: [], any: false });
            }}
          >
            Clear all
          </Button>
        )}
        <Spacer />
        <Button onClick={onClose}>Done</Button>
      </ModalFooter>
    </Modal>
  );
}

interface RuleEditorProps {
  rule: Rule;
  fields: FilterField[];
  items: Item[];
  onChange(rule: Rule): void;
  onRemove(): void;
}

function RuleEditor({ rule, fields, items, onChange, onRemove }: RuleEditorProps) {
  const field = fieldById(fields, rule.field);
  const conditions = conditionsFor(field);
  const known = fields.some((f) => f.id === rule.field);

  return (
    <RuleRow>
      <select
        aria-label="Field"
        value={rule.field}
        onChange={(e) => {
          const next = fieldById(fields, e.target.value);
          // Keep the condition and values when they still make sense, e.g. Author → Title.
          const keep = next.kind === field.kind;
          const condition = keep ? rule.condition : conditionsFor(next)[0]!;
          onChange({ field: next.id, condition, values: keep ? rule.values : defaultValues(next, condition) });
        }}
      >
        {!known && <option value={rule.field}>{field.label}</option>}
        {fields.map((f) => (
          <option key={f.id} value={f.id}>
            {f.label}
          </option>
        ))}
      </select>
      <select
        aria-label="Condition"
        value={rule.condition}
        onChange={(e) => {
          const condition = e.target.value as Condition;
          const sameShape = (c: Condition) => (c === 'inLast' ? 'last' : c === 'after' || c === 'before' ? 'date' : 'value');
          const keep = sameShape(condition) === sameShape(rule.condition) && rule.values.length > 0;
          onChange({ ...rule, condition, values: keep ? rule.values : defaultValues(field, condition) });
        }}
      >
        {conditions.map((c) => (
          <option key={c} value={c}>
            {conditionLabel(field, c)}
          </option>
        ))}
      </select>
      <Button $variant="icon" aria-label="Remove rule" title="Remove rule" onClick={onRemove}>
        ×
      </Button>
      <Value>
        <RuleValue rule={rule} field={field} items={items} onChange={(values) => onChange({ ...rule, values })} />
      </Value>
    </RuleRow>
  );
}

function RuleValue({
  rule,
  field,
  items,
  onChange,
}: {
  rule: Rule;
  field: FilterField;
  items: Item[];
  onChange(values: string[]): void;
}) {
  const listId = useId();
  const suggestions = useMemo(
    () => (field.id === 'text' || field.id === 'title' || field.kind !== 'text' && field.kind !== 'set' ? [] : fieldSuggestions(items, field.id)),
    [items, field],
  );
  const value = rule.values[0] ?? '';

  switch (rule.condition) {
    case 'present':
    case 'absent':
      return null;
    case 'anyOf':
    case 'noneOf':
      return <ValuesInput values={rule.values} suggestions={suggestions} label={field.label} onChange={onChange} />;
    case 'inLast': {
      const [amount = '30', unit = 'days'] = value.split(' ');
      return (
        <>
          <input
            type="number"
            min={1}
            aria-label="How many"
            value={amount}
            onChange={(e) => onChange([`${e.target.value} ${unit}`])}
          />
          <select aria-label="Unit" value={unit} onChange={(e) => onChange([`${amount} ${e.target.value}`])}>
            {DATE_UNITS.map((u) => (
              <option key={u} value={u}>
                {u}
              </option>
            ))}
          </select>
        </>
      );
    }
    case 'after':
    case 'before':
      // Dates can be partial ("1900", "2026-09"), which a date input can't hold, so this is text with a hint.
      return (
        <input
          aria-label="Date"
          placeholder="YYYY, YYYY-MM, YYYY-MM-DD or -0570 for 570 BC"
          pattern="-?\d{4}(-\d{2}){0,2}"
          value={value}
          onChange={(e) => onChange([e.target.value.trim()])}
        />
      );
  }
  if (field.kind === 'rating') {
    return (
      <select aria-label="Stars" value={value} onChange={(e) => onChange([e.target.value])}>
        {[1, 2, 3, 4, 5].map((n) => (
          <option key={n} value={String(n)}>
            {'★'.repeat(n)}
          </option>
        ))}
      </select>
    );
  }
  if (field.kind === 'number') {
    return <input type="number" aria-label={field.label} value={value} onChange={(e) => onChange([e.target.value])} />;
  }
  return (
    <>
      <input
        aria-label={field.label}
        list={suggestions.length ? listId : undefined}
        placeholder={field.id === 'text' ? 'Words anywhere in the book’s details' : undefined}
        value={value}
        onChange={(e) => onChange([e.target.value])}
      />
      {suggestions.length > 0 && <Suggestions id={listId} values={suggestions} />}
    </>
  );
}

const Suggestions = ({ id, values }: { id: string; values: string[] }) => (
  <datalist id={id}>
    {values.map((v) => (
      <option key={v} value={v} />
    ))}
  </datalist>
);

/** Several values as chips, added by picking a suggestion or typing one and pressing Enter. */
function ValuesInput({
  values,
  suggestions,
  label,
  onChange,
}: {
  values: string[];
  suggestions: string[];
  label: string;
  onChange(values: string[]): void;
}) {
  const [draft, setDraft] = useState('');
  const listId = useId();
  const add = (value: string) => {
    const trimmed = value.trim().replace(/,$/, '');
    if (trimmed && !values.some((v) => v.toLowerCase() === trimmed.toLowerCase())) onChange([...values, trimmed]);
    setDraft('');
  };
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      add(draft);
    } else if (e.key === 'Backspace' && !draft && values.length) {
      onChange(values.slice(0, -1));
    }
  };
  const offered = suggestions.filter((s) => !values.includes(s));

  return (
    <>
      {values.length > 0 && (
        <TagList>
          {values.map((v) => (
            <Tag key={v}>
              <TagLabel>{v}</TagLabel>
              <TagRemove aria-label={`Remove ${v}`} onClick={() => onChange(values.filter((x) => x !== v))}>
                ×
              </TagRemove>
            </Tag>
          ))}
        </TagList>
      )}
      <input
        aria-label={`Add ${label.toLowerCase()}`}
        list={offered.length ? listId : undefined}
        placeholder={values.length ? 'or…' : `Choose ${label.toLowerCase()}`}
        value={draft}
        onKeyDown={onKeyDown}
        onBlur={() => draft.trim() && add(draft)}
        onChange={(e) => {
          // Picking from the list fills in a whole suggestion: take it straight away.
          if (offered.includes(e.target.value)) add(e.target.value);
          else setDraft(e.target.value);
        }}
      />
      {offered.length > 0 && <Suggestions id={listId} values={offered} />}
    </>
  );
}
