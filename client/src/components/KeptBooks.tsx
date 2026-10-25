import { useState } from 'react';
import styled from 'styled-components';
import { useLibrary } from '../library/LibraryContext';
import { addInstances, EVERY_BOOK } from '../sync/instances';
import { Button, Muted } from '../styles/ui';
import { QueryInput, useMatchCount } from './QueryInput';
import { t } from '../i18n';

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
          {t('keptBooks.explain', { name })}
        </Muted>
        <QueryInput value={draft} onChange={setDraft} aria-label={t('keptBooks.label', { name })} />
        <Line>
          <Button
            $size="small"
            onClick={() => {
              onChange(draft.trim() || EVERY_BOOK);
              setDraft(undefined);
            }}
          >
            {t('common.done')}
          </Button>
          <Button $variant="secondary" $size="small" onClick={() => setDraft(undefined)}>
            {t('common.cancel')}
          </Button>
        </Line>
      </Editing>
    );
  }
  return (
    <Line>
      <Muted>
        {t('keptBooks.gets', { what: everyBook(query) ? t('keptBooks.everyBook') : t('keptBooks.matching', { query }) })}
        {count !== undefined && t('keptBooks.now', { count })}
        {excluded > 0 && t('keptBooks.less', { count: excluded })}
        {t('keptBooks.end')}
      </Muted>
      <Button $variant="secondary" $size="small" onClick={() => setDraft(everyBook(query) ? '' : query)}>
        {t('keptBooks.choose')}
      </Button>
      {excluded > 0 && onBringBack && (
        <Button $variant="secondary" $size="small" onClick={onBringBack}>
          {t('keptBooks.bringBack')}
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
