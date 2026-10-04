import type { FileRef, Item, ItemId } from '@nexlibris/common';
import { useDeferredValue, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import styled from 'styled-components';
import { locate, type Passage } from '../fulltext/match';
import { useTextSearch, type TextHit } from '../fulltext/TextIndexContext';
import { describeRule, filtersQuery, parseFilters, type FilterField } from '../library/filters';
import { filterItems } from '../library/search';
import { suggest } from '../library/suggest';
import { usePersistentState } from '../library/usePersistentState';
import { NARROW } from '../styles/GlobalStyle';
import { Button, Muted, Tag, TagButton, TagLabel, TagRemove } from '../styles/ui';
import { Cover } from './Cover';
import { coverageNote, passagePlace, Snippet } from './TextResults';
import { FilterIcon, SearchIcon } from './icons';

const Dialog = styled.dialog`
  width: min(680px, calc(100vw - 24px));
  max-height: min(640px, calc(100vh - 20vh));
  margin: 12vh auto auto;
  padding: 0;
  border: 1px solid var(--border);
  border-radius: 14px;
  background: var(--surface);
  color: var(--text);
  box-shadow: 0 20px 60px rgb(0 0 0 / 0.3);
  overflow: hidden;

  &[open] {
    display: flex;
    flex-direction: column;
  }

  &::backdrop {
    background: rgb(0 0 0 / 0.25);
    backdrop-filter: blur(2px);
  }

  ${NARROW} {
    width: 100vw;
    max-width: 100vw;
    max-height: 85vh;
    margin: 0 0 auto;
    border-width: 0 0 1px;
    border-radius: 0 0 14px 14px;
  }
`;

const Field = styled.div`
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px 12px 12px 18px;
  border-bottom: 1px solid var(--border);
  color: var(--muted);

  > input {
    flex: 1;
    min-width: 0;
    padding: 6px 0;
    border: none;
    background: none;
    color: var(--text);
    font-size: 1.25rem;
    outline: none;
    box-shadow: none;
  }

  > svg {
    flex: none;
    font-size: 1.2rem;
  }
`;

/** Books or their text: what's searched, always in view, so the results are never mixed. */
const Modes = styled.div`
  display: flex;
  gap: 4px;
  padding: 8px 18px 0;

  > button {
    padding: 4px 12px;
    border: 1px solid var(--border);
    border-radius: 999px;
    background: none;
    color: var(--muted);
    font: inherit;
    font-size: 0.9em;
    cursor: pointer;
  }

  > button[aria-checked='true'] {
    border-color: var(--soft-border);
    background: var(--soft);
    color: var(--text);
    font-weight: 600;
  }
`;

/** A book found by its text: its title, then the passage. */
const HitText = styled.div`
  flex: 1;
  min-width: 0;
  line-height: 1.4;

  > strong {
    display: block;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  > div {
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
    color: var(--muted);
    font-size: 0.9em;
  }
`;

const Scroll = styled.div`
  overflow-y: auto;
  padding: 6px 0 10px;
`;

const Section = styled.section`
  padding: 6px 12px;

  h3 {
    display: flex;
    align-items: center;
    gap: 8px;
    margin: 4px 6px 6px;
    color: var(--muted);
    font-size: 0.75rem;
    font-weight: 600;
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }
`;

const Chips = styled.div`
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  padding: 0 6px;
`;

const Options = styled.ul`
  margin: 0;
  padding: 0;
  list-style: none;
`;

const Option = styled.li`
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 7px 10px;
  border-radius: var(--radius);
  cursor: pointer;

  &[aria-selected='true'] {
    background: var(--soft);
  }

  &:hover {
    background: var(--hover);
  }

  > span:first-of-type {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
`;

const QuietButton = styled.button.attrs({ type: 'button' })`
  padding: 0;
  border: none;
  background: none;
  color: var(--muted);
  font: inherit;
  text-transform: none;
  letter-spacing: 0;
  text-decoration: underline;
  cursor: pointer;
`;

const Nothing = styled.p`
  margin: 4px 10px;
  color: var(--muted);
`;

const Kind = styled.span`
  color: var(--muted);
  font-size: 0.85em;
`;

const Thumb = styled(Cover)`
  flex: none;
  width: 24px;
  border-radius: 2px;
  font-size: 0;
`;

const Footer = styled.footer`
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 18px;
  border-top: 1px solid var(--border);
  color: var(--muted);
  font-size: 0.8rem;

  kbd {
    padding: 0 4px;
    border: 1px solid var(--border);
    border-radius: 4px;
    font: inherit;
  }

  ${NARROW} {
    display: none;
  }
`;

/** Fields offered as starting points before anything is typed. */
const STARTERS = [
  ['Author', 'author:'],
  ['Title', 'title:'],
  ['Series', 'series:'],
  ['Tag', 'tag:'],
  ['Format', 'format:'],
  ['Rating', 'rating:'],
  ['Added', 'added:'],
  ['Has…', 'has:'],
] as const;

const RECENT_LIMIT = 6;
const BOOK_LIMIT = 6;
const TEXT_LIMIT = 5;

export type SearchMode = 'books' | 'text';

type Choice =
  | { kind: 'suggestion'; query: string; caret: number }
  | { kind: 'book'; id: ItemId }
  | { kind: 'passage'; hit: TextHit; passage: Passage };

interface Props {
  /** The search in the bar, to start from. */
  query: string;
  /** Searching books (their titles, authors, metadata) or the text inside them. */
  mode: SearchMode;
  filterQuery: string;
  items: Item[];
  fields: FilterField[];
  ratings: Record<string, number>;
  /** Enter or the Search button: the bar takes this search and the dialog closes. */
  onSearch(query: string, mode: SearchMode): void;
  /** A passage picked from a search of the text: searched for, then read from there. */
  onRead(item: Item, file: FileRef, locator: string): void;
  /** Escape or a click outside: the bar keeps its search. */
  onClose(): void;
  onFilterQuery(query: string): void;
  onEditFilters(): void;
  /** A book picked from the results: searched for, then opened. */
  onOpenItem(id: ItemId): void;
  /** Where the search applies, when that's a place narrower than all books (a tag, an author). */
  scope?: { label: string; filter(items: Item[]): Item[] };
  /** The scope was removed: the search goes to all books. */
  onLeaveScope?(): void;
}

/**
 * Searching, as Apple's Spotlight: a field over the page with completions for the word being
 * typed, the filters that apply, and the first books found. Enter puts the search in the bar.
 */
export function SearchDialog(props: Props) {
  const { query, filterQuery, items, fields, ratings, onSearch, onClose, onFilterQuery, onEditFilters, onOpenItem, onRead, scope } = props;
  const ref = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const listId = useId();
  const [draft, setDraft] = useState(query);
  const [caret, setCaret] = useState(query.length);
  const [active, setActive] = useState(-1);
  const [scoped, setScoped] = useState(scope !== undefined);
  const [mode, setMode] = useState(props.mode);
  const text = mode === 'text';
  /** Where to put the caret after a completion, once React has written the new text. */
  const pendingCaret = useRef<number>(undefined);
  const recentSearches = {
    books: usePersistentState<string[]>('nexlibris:recentSearches', []),
    text: usePersistentState<string[]>('nexlibris:recentTextSearches', []),
  };
  const [recent, setRecent] = recentSearches[mode];

  useEffect(() => {
    if (!ref.current?.open) ref.current?.showModal();
    input.current?.select();
  }, []);
  useLayoutEffect(() => {
    if (pendingCaret.current === undefined) return;
    input.current?.setSelectionRange(pendingCaret.current, pendingCaret.current);
    pendingCaret.current = undefined;
  });

  const suggestions = useMemo(() => (text ? [] : suggest(draft, caret, items, fields)), [text, draft, caret, items, fields]);
  const searched = useDeferredValue(draft);
  /** The books searched: those in the scope that pass the filters. */
  const pool = useMemo(() => {
    const within = scoped && scope ? scope.filter(items) : items;
    return filterItems(within, filterQuery, { ratings });
  }, [items, filterQuery, ratings, scoped, scope]);
  const found = useMemo(() => (text ? [] : filterItems(pool, searched, { ratings })), [text, pool, searched, ratings]);
  const books = searched.trim() ? found.slice(0, BOOK_LIMIT) : [];
  const textSearch = useTextSearch(text ? searched : '', pool, TEXT_LIMIT);
  const choices: Choice[] = [
    ...suggestions.map((s): Choice => ({ kind: 'suggestion', query: s.query, caret: s.caret })),
    ...books.map((b): Choice => ({ kind: 'book', id: b.id })),
    ...textSearch.hits.map((hit): Choice => ({ kind: 'passage', hit, passage: hit.match.passages[0]! })),
  ];
  const filters = filterQuery ? parseFilters(filterQuery, fields) : undefined;
  /** The search as filters, if rules can say it, to offer keeping it as filters. */
  const asFilters = !text && draft.trim() ? parseFilters(draft, fields) : undefined;

  const edit = (text: string, at = text.length) => {
    setDraft(text);
    setCaret(at);
    setActive(-1);
    pendingCaret.current = at;
  };
  const insert = (text: string) => {
    const base = draft.trimEnd();
    edit(base ? `${base} ${text}` : text);
    input.current?.focus();
  };
  const clear = () => {
    edit('');
    input.current?.focus();
  };
  const submit = (text = draft) => {
    const trimmed = text.trim();
    if (trimmed) setRecent([trimmed, ...recent.filter((r) => r !== trimmed)].slice(0, RECENT_LIMIT));
    if (scope && !scoped) props.onLeaveScope?.();
    onSearch(trimmed, mode);
  };
  const choose = (choice: Choice) => {
    if (choice.kind === 'suggestion') {
      edit(choice.query, choice.caret);
      input.current?.focus();
    } else if (choice.kind === 'book') {
      submit();
      onOpenItem(choice.id);
    } else {
      submit();
      onRead(choice.hit.item, choice.hit.file, locate(choice.hit.doc, choice.passage));
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (!choices.length) return;
      e.preventDefault();
      const step = e.key === 'ArrowDown' ? 1 : -1;
      // Through the choices and back to the field (-1), wrapping round.
      setActive((i) => ((i + 1 + step + choices.length + 1) % (choices.length + 1)) - 1);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const choice = choices[active];
      if (choice) choose(choice);
      else submit();
    } else if (e.key === 'Tab' && !e.shiftKey && suggestions.length) {
      e.preventDefault();
      // The highlighted completion, else the first.
      choose(choices[active]?.kind === 'suggestion' ? choices[active] : choices[0]!);
    }
  };

  const optionId = (i: number) => `${listId}-${i}`;
  const caretFrom = (el: HTMLInputElement) => setCaret(el.selectionStart ?? el.value.length);

  return (
    <Dialog
      ref={ref}
      aria-label="Search"
      onClose={onClose}
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <Field>
        <SearchIcon />
        <input
          ref={input}
          type="text"
          inputMode="search"
          role="combobox"
          aria-label="Search"
          aria-expanded={choices.length > 0}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={active >= 0 ? optionId(active) : undefined}
          placeholder={text ? 'Search the text of books…' : 'Search titles, authors, tags…'}
          enterKeyHint="search"
          autoComplete="off"
          spellCheck={false}
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value);
            caretFrom(e.target);
            setActive(-1);
          }}
          onSelect={(e) => caretFrom(e.currentTarget)}
          onKeyDown={onKeyDown}
        />
        {draft && (
          <Button $variant="icon" aria-label="Clear" title="Clear" onClick={clear}>
            ×
          </Button>
        )}
        <Button $size="small" onClick={() => submit()}>
          Search
        </Button>
      </Field>
      <Modes role="radiogroup" aria-label="Search in" onMouseDown={(e) => e.preventDefault()}>
        {(
          [
            ['books', 'Books'],
            ['text', 'Inside books'],
          ] as const
        ).map(([value, label]) => (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={mode === value}
            onClick={() => {
              setMode(value);
              setActive(-1);
              input.current?.focus();
            }}
          >
            {label}
          </button>
        ))}
      </Modes>

      {/* Clicking a button here leaves the focus in the field, so typing (and Enter) carries on there, also once the filters dialog closes. */}
      <Scroll onMouseDown={(e) => (e.target as Element).closest('button') && e.preventDefault()}>
        <Section aria-label="Filters">
          <h3>
            <FilterIcon /> Filters
          </h3>
          <Chips>
            {scope && scoped && (
              <Tag>
                <TagLabel>In {scope.label}</TagLabel>
                <TagRemove aria-label={`Search all books, not just ${scope.label}`} title="Search all books" onClick={() => {
                  setScoped(false);
                  input.current?.focus();
                }}>
                  ×
                </TagRemove>
              </Tag>
            )}
            {filters
              ? filters.rules.map((rule, index) => (
                  <Tag key={index}>
                    <TagLabel>{describeRule(rule, fields)}</TagLabel>
                    <TagRemove
                      aria-label={`Remove filter: ${describeRule(rule, fields)}`}
                      onClick={() => {
                        onFilterQuery(filtersQuery({ ...filters, rules: filters.rules.filter((_, i) => i !== index) }));
                        input.current?.focus();
                      }}
                    >
                      ×
                    </TagRemove>
                  </Tag>
                ))
              : filterQuery && <TagButton onClick={onEditFilters}>{filterQuery}</TagButton>}
            <Button $variant="secondary" $size="small" onClick={onEditFilters}>
              {filterQuery ? 'Edit filters…' : 'Add a filter…'}
            </Button>
            {asFilters && (
              <Button
                $variant="secondary"
                $size="small"
                title="Keep this search as filters, which stay on while you search for other things"
                onClick={() => {
                  onFilterQuery([filterQuery, draft.trim()].filter(Boolean).join(filters?.any ? ' or ' : ' '));
                  edit('');
                  input.current?.focus();
                }}
              >
                Keep as filter
              </Button>
            )}
          </Chips>
        </Section>

        {!text && !draft.trim() && (
          <Section aria-label="Search by">
            <h3>Search by</h3>
            <Chips>
              {STARTERS.map(([label, text]) => (
                <TagButton key={text} onClick={() => insert(text)}>
                  {label}
                </TagButton>
              ))}
            </Chips>
          </Section>
        )}

        {!draft.trim() && recent.length > 0 && (
          <Section aria-label="Recent searches">
            <h3>
              Recent
              <QuietButton onClick={() => setRecent([])}>Clear</QuietButton>
            </h3>
            <Options>
              {recent.map((r) => (
                <Option key={r} onClick={() => submit(r)}>
                  <span>{r}</span>
                </Option>
              ))}
            </Options>
          </Section>
        )}

        <Options id={listId} role="listbox" aria-label="Suggestions">
          {suggestions.length > 0 && (
            <Section as="li" role="presentation">
              <h3>Suggestions</h3>
              <Options role="presentation">
                {suggestions.map((s, i) => (
                  <Option
                    key={`${s.kind}:${s.label}`}
                    id={optionId(i)}
                    role="option"
                    aria-selected={active === i}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => choose(choices[i]!)}
                  >
                    <span>{s.label}</span>
                    <Kind>{s.kind}</Kind>
                  </Option>
                ))}
              </Options>
            </Section>
          )}
          {text && (searched.trim() || coverageNote(textSearch.coverage)) && (
            <Section as="li" role="presentation">
              <h3>
                Inside books{' '}
                {searched.trim() && (
                  <Muted>
                    · {textSearch.searching ? 'searching…' : textSearch.hits.length ? `${textSearch.hits.length}${textSearch.hits.length === TEXT_LIMIT ? '+' : ''} ${textSearch.hits.length === 1 ? 'book' : 'books'}` : 'nothing found'}
                  </Muted>
                )}
              </h3>
              {coverageNote(textSearch.coverage) && <Nothing>{coverageNote(textSearch.coverage)}</Nothing>}
              <Options role="presentation">
                {textSearch.hits.map((hit, j) => {
                  const i = suggestions.length + books.length + j;
                  const passage = hit.match.passages[0]!;
                  const place = passagePlace(hit, passage);
                  return (
                    <Option
                      key={hit.item.id}
                      id={optionId(i)}
                      role="option"
                      aria-selected={active === i}
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => choose(choices[i]!)}
                    >
                      <Thumb item={hit.item} />
                      <HitText>
                        <strong>{hit.item.title}</strong>
                        <div>
                          {place && `${place}: `}
                          <Snippet passage={passage} />
                        </div>
                      </HitText>
                      <Kind>
                        {hit.match.total} {hit.match.total === 1 ? 'match' : 'matches'}
                      </Kind>
                    </Option>
                  );
                })}
              </Options>
            </Section>
          )}
          {!text && searched.trim() && (
            <Section as="li" role="presentation">
              <h3>
                Books <Muted>· {found.length === 1 ? '1 match' : `${found.length} matches`}</Muted>
              </h3>
              {books.length === 0 ? (
                <Nothing>Nothing matches{filterQuery ? ' with these filters' : ''}.</Nothing>
              ) : (
                <Options role="presentation">
                  {books.map((book, j) => {
                    const i = suggestions.length + j;
                    return (
                      <Option
                        key={book.id}
                        id={optionId(i)}
                        role="option"
                        aria-selected={active === i}
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={() => choose(choices[i]!)}
                      >
                        <Thumb item={book} />
                        <span>{book.title}</span>
                        <Kind>{book.creators[0]?.name}</Kind>
                      </Option>
                    );
                  })}
                </Options>
              )}
            </Section>
          )}
        </Options>
      </Scroll>

      <Footer>
        <span>
          <kbd>↑</kbd> <kbd>↓</kbd> choose
        </span>
        {!text && (
          <span>
            <kbd>Tab</kbd> complete
          </span>
        )}
        <span>
          <kbd>Enter</kbd> search
        </span>
        <span>
          <kbd>Esc</kbd> cancel
        </span>
      </Footer>
    </Dialog>
  );
}
