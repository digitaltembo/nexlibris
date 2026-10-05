import { userData } from '@nexlibris/common';
import { useState } from 'react';
import styled from 'styled-components';
import { useLibrary } from '../library/LibraryContext';
import { describeRule, filterFields, parseFilters } from '../library/filters';
import { filterItems } from '../library/search';
import { addInstances, EVERY_BOOK } from '../sync/instances';
import { Button, Muted } from '../styles/ui';
import { FiltersDialog } from './FiltersDialog';

const Line = styled.span`
  display: inline-flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 4px 8px;
`;

const lowerFirst = (text: string) => text.charAt(0).toLowerCase() + text.slice(1);

/** Whether a search means every book with a file (no rules, or the default rule). */
const everyBook = (query: string) => !query.trim() || query.trim() === EVERY_BOOK;

/**
 * Which books another instance gets, as its connection's rules, with a button to choose: it sees
 * only those (their details, covers and files), and books deleted there stay here, kept off it
 * (`excluded`), which `onBringBack` undoes.
 */
export function KeptBooks({
  name,
  query,
  onChange,
  excluded = 0,
  onBringBack,
}: {
  name: string;
  query: string;
  onChange(query: string): void;
  /** How many books were deleted there, and so kept off it. */
  excluded?: number;
  onBringBack?(): void;
}) {
  const { library } = useLibrary();
  const [editing, setEditing] = useState(false);
  const items = Object.values(library.items);
  const count = (q: string) => (q.trim() ? filterItems(items, q, { ratings: userData(library).ratings }).length : items.length);
  const fields = filterFields(items);
  const rules = everyBook(query) ? undefined : parseFilters(query, fields);
  const described = rules?.rules.map((rule) => describeRule(rule, fields)) ?? [];
  const summary = everyBook(query)
    ? 'every book'
    : described.length
      ? `books where ${lowerFirst(described.join(rules!.any ? ' or ' : ', '))}`
      : `books matching “${query}”`;
  return (
    <Line>
      <Muted>
        Gets {summary}
        {!everyBook(query) && ` (${count(query)} now)`}
        {excluded > 0 && `, less ${excluded} deleted there`}.
      </Muted>
      <Button $variant="secondary" $size="small" onClick={() => setEditing(true)}>
        Choose books…
      </Button>
      {excluded > 0 && onBringBack && (
        <Button $variant="secondary" $size="small" onClick={onBringBack}>
          Bring back deleted
        </Button>
      )}
      {editing && (
        <FiltersDialog
          title={`Books ${name} gets`}
          intro={`Only these books go to ${name}: their details, covers and files, along with any added to it by hand. ${name} doesn’t see the others, and books deleted there stay here.`}
          query={everyBook(query) ? '' : query}
          onChange={(q) => onChange(q.trim() || EVERY_BOOK)}
          onClose={() => setEditing(false)}
          items={items}
          count={count}
        />
      )}
    </Line>
  );
}

/** {@link KeptBooks} for a paired instance, changing its connection (made here if it hasn't synced yet). */
export function PeerKeptBooks({ origin, name }: { origin: string; name: string }) {
  const { library, apply } = useLibrary();
  const device = library.devices?.[origin];
  const excluded = device?.excluded ?? [];
  return (
    <KeptBooks
      name={device?.name ?? name}
      query={device?.query ?? EVERY_BOOK}
      excluded={excluded.length}
      onBringBack={() => void apply([{ type: 'unexcludeDeviceItems', id: origin, itemIds: excluded }])}
      onChange={(query) =>
        void apply(
          device
            ? [{ type: 'updateDevice', id: origin, patch: { query } }]
            : addInstances(library, [{ origin, name }], query),
        )
      }
    />
  );
}
