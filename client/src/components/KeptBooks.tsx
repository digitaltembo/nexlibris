import { useState } from 'react';
import styled from 'styled-components';
import { useLibrary } from '../library/LibraryContext';
import { addInstances, EVERY_BOOK } from '../sync/instances';
import { Button, Muted } from '../styles/ui';
import { QueryInput, useMatchCount } from './QueryInput';

const Line = styled.span`
  display: inline-flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 4px 8px;
`;

const Editing = styled.span`
  display: flex;
  flex-direction: column;
  gap: 4px;
  width: 100%;
`;

/** Whether a search means every book with a file (none, or the default one). */
const everyBook = (query: string) => !query.trim() || query.trim() === EVERY_BOOK;

/**
 * Which books another instance gets, as its connection's search, with a button to choose: it sees
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
  /** The search being typed, applied by Done (a pairing code is made again for each). */
  const [draft, setDraft] = useState<string>();
  const count = useMatchCount(everyBook(query) ? '' : query);
  if (draft !== undefined) {
    return (
      <Editing>
        <Muted>
          Only books matching this search go to {name} (their details, covers and files), along with any added to it by hand.
          Empty for every book.
        </Muted>
        <QueryInput value={draft} onChange={setDraft} aria-label={`Books ${name} gets`} />
        <Line>
          <Button
            $size="small"
            onClick={() => {
              onChange(draft.trim() || EVERY_BOOK);
              setDraft(undefined);
            }}
          >
            Done
          </Button>
          <Button $variant="secondary" $size="small" onClick={() => setDraft(undefined)}>
            Cancel
          </Button>
        </Line>
      </Editing>
    );
  }
  return (
    <Line>
      <Muted>
        Gets {everyBook(query) ? 'every book' : `books matching “${query}”`}
        {count !== undefined && ` (${count} now)`}
        {excluded > 0 && `, less ${excluded} deleted there`}.
      </Muted>
      <Button $variant="secondary" $size="small" onClick={() => setDraft(everyBook(query) ? '' : query)}>
        Choose books…
      </Button>
      {excluded > 0 && onBringBack && (
        <Button $variant="secondary" $size="small" onClick={onBringBack}>
          Bring back deleted
        </Button>
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
