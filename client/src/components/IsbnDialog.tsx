import { createItem, formatYear, type ItemId } from '@nexlibris/common';
import { useCallback, useRef, useState, type FormEvent } from 'react';
import styled from 'styled-components';
import { formatIsbn, itemsWithIsbn, normalizeIsbn } from '../isbn/isbn';
import { itemFromBook, lookupIsbn, type BookInfo } from '../isbn/openLibrary';
import { cameraAvailable, isbnReader, readIsbnFromImage } from '../isbn/scanner';
import { useLibrary } from '../library/LibraryContext';
import { Button, FileButton, Muted, Row, Spacer } from '../styles/ui';
import { CameraScanner } from './CameraScanner';
import { Modal, ModalFooter } from './Modal';
import { t } from '../i18n';

const Controls = styled(Row)`
  flex-wrap: wrap;
  margin-top: 16px;

  > form {
    display: flex;
    flex: 1 1 220px;
    gap: 6px;
  }

  > form > input {
    flex: 1;
    min-width: 0;
  }
`;

const Results = styled.ul`
  list-style: none;
  margin: 16px 0 0;
  padding: 0;
  max-height: 40vh;
  overflow-y: auto;
`;

const Result = styled.li`
  display: flex;
  gap: 10px;
  align-items: center;
  padding: 8px 0;
  border-top: 1px solid var(--border);

  img,
  .placeholder {
    flex: none;
    width: 36px;
    height: 54px;
    object-fit: cover;
    border-radius: 3px;
    background: var(--soft);
  }

  > div {
    flex: 1;
    min-width: 0;
  }

  strong {
    display: block;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  ${Muted} {
    display: block;
    font-size: 0.85rem;
  }
`;

const ErrorText = styled.p`
  margin: 8px 0 0;
  color: var(--danger);
`;

type Entry =
  | { isbn: string; state: 'looking' }
  | { isbn: string; state: 'found'; book: BookInfo }
  | { isbn: string; state: 'missing' }
  | { isbn: string; state: 'failed'; error: string };

const errorMessage = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * Adding books by ISBN: scanned from the barcode with the camera or a photo, or typed. Each
 * is looked up on Open Library and listed, to be added as an item without a file.
 */
export function IsbnDialog({ onClose, onOpen }: { onClose(): void; onOpen(id: ItemId): void }) {
  const { backend, library, apply } = useLibrary();
  const [entries, setEntries] = useState<Entry[]>([]);
  const [added, setAdded] = useState<Record<string, ItemId>>({});
  const [adding, setAdding] = useState<ReadonlySet<string>>(new Set());
  const [scanning, setScanning] = useState(false);
  const [typed, setTyped] = useState('');
  const [error, setError] = useState<string>();
  const seen = useRef(new Set<string>());

  const lookUp = useCallback((isbn: string) => {
    const update = (entry: Entry) => setEntries((list) => list.map((e) => (e.isbn === isbn ? entry : e)));
    setEntries((list) => [{ isbn, state: 'looking' }, ...list.filter((e) => e.isbn !== isbn)]);
    lookupIsbn(isbn).then(
      (book) => update(book ? { isbn, state: 'found', book } : { isbn, state: 'missing' }),
      (e) => update({ isbn, state: 'failed', error: errorMessage(e) }),
    );
  }, []);

  /** A barcode or typed ISBN; ones already listed are left alone, so a barcode held in view counts once. */
  const offer = useCallback(
    (isbn: string) => {
      if (seen.current.has(isbn)) return;
      seen.current.add(isbn);
      navigator.vibrate?.(40);
      lookUp(isbn);
    },
    [lookUp],
  );

  const submitTyped = (e: FormEvent) => {
    e.preventDefault();
    const isbn = normalizeIsbn(typed);
    if (!isbn) {
      setError(t('isbn.invalid', { typed: typed.trim() }));
      return;
    }
    setError(undefined);
    setTyped('');
    // Typing one again looks it up again (e.g. after a failed lookup).
    seen.current.delete(isbn);
    offer(isbn);
  };

  const readPhoto = async (file: File) => {
    setError(undefined);
    try {
      const found = await readIsbnFromImage(file);
      if (!found.length) setError(t('isbn.noBarcode'));
      for (const isbn of found) offer(isbn);
    } catch (e) {
      setError(t('isbn.photoFailed', { message: errorMessage(e) }));
    }
  };

  const add = async (entries: Entry[]) => {
    const isbns = entries.map((e) => e.isbn);
    setAdding((current) => new Set([...current, ...isbns]));
    setError(undefined);
    try {
      for (const entry of entries) {
        const item =
          entry.state === 'found'
            ? await itemFromBook(backend, entry.book)
            : createItem({ title: t('isbn.isbnTitle', { isbn: formatIsbn(entry.isbn) }), identifiers: { isbn: entry.isbn } });
        await apply([{ type: 'addItem', item }]);
        setAdded((current) => ({ ...current, [entry.isbn]: item.id }));
      }
    } catch (e) {
      setError(t('isbn.addFailed', { message: errorMessage(e) }));
    } finally {
      setAdding((current) => new Set([...current].filter((isbn) => !isbns.includes(isbn))));
    }
  };

  const inLibrary = (isbn: string) => added[isbn] ?? itemsWithIsbn(library, isbn)[0]?.id;
  const addable = entries.filter((e) => e.state === 'found' && !inLibrary(e.isbn) && !adding.has(e.isbn));

  return (
    <Modal title={t('isbn.title')} onClose={onClose}>
      <Muted as="p">
        {t('isbn.explain')}
      </Muted>

      {scanning && (
        <CameraScanner
          reader={isbnReader}
          onValue={offer}
          onError={(message) => (setError(message), setScanning(false))}
          hint={t('isbn.hint')}
          otherwise={t('isbn.otherwise')}
        />
      )}

      <Controls>
        {cameraAvailable() && (
          <Button $variant={scanning ? 'secondary' : 'primary'} onClick={() => (setError(undefined), setScanning(!scanning))}>
            {scanning ? t('isbn.stopCamera') : t('isbn.scan')}
          </Button>
        )}
        <FileButton $variant="secondary">
          {t('isbn.photo')}
          <input
            type="file"
            accept="image/*"
            capture="environment"
            hidden
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = '';
              if (file) void readPhoto(file);
            }}
          />
        </FileButton>
        <form onSubmit={submitTyped}>
          <input
            inputMode="numeric"
            placeholder={t('isbn.placeholder')}
            aria-label={t('isbn.label')}
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
          />
          <Button type="submit" $variant="secondary" disabled={!typed.trim()}>
            {t('isbn.lookUp')}
          </Button>
        </form>
      </Controls>

      {error && <ErrorText role="alert">{error}</ErrorText>}

      {entries.length > 0 && (
        <Results aria-label={t('isbn.found')}>
          {entries.map((entry) => (
            <EntryRow
              key={entry.isbn}
              entry={entry}
              existing={inLibrary(entry.isbn)}
              wasAdded={entry.isbn in added}
              adding={adding.has(entry.isbn)}
              onAdd={() => void add([entry])}
              onRetry={() => lookUp(entry.isbn)}
              onOpen={onOpen}
            />
          ))}
        </Results>
      )}

      <ModalFooter>
        {addable.length > 1 && <Button onClick={() => void add(addable)}>{t('isbn.addAll', { count: addable.length })}</Button>}
        <Spacer />
        <Button $variant="secondary" onClick={onClose}>
          {t('common.close')}
        </Button>
      </ModalFooter>
    </Modal>
  );
}

interface EntryRowProps {
  entry: Entry;
  existing: ItemId | undefined;
  wasAdded: boolean;
  adding: boolean;
  onAdd(): void;
  onRetry(): void;
  onOpen(id: ItemId): void;
}

function EntryRow({ entry, existing, wasAdded, adding, onAdd, onRetry, onOpen }: EntryRowProps) {
  const book = entry.state === 'found' ? entry.book : undefined;
  const details = book && [
    book.creators.map((c) => c.name).join(', '),
    formatYear(String(book.metadata.published ?? '')),
    book.metadata.publisher,
  ];
  const thumbnail = book?.coverUrl?.replace(/-L\.jpg$/, '-M.jpg');

  let action;
  if (existing) {
    action = (
      <Button $variant="secondary" $size="small" onClick={() => onOpen(existing)}>
        {wasAdded ? t('isbn.addedOpen') : t('isbn.inLibraryOpen')}
      </Button>
    );
  } else if (adding) {
    action = <Muted>{t('isbn.adding')}</Muted>;
  } else if (entry.state === 'found') {
    action = (
      <Button $size="small" onClick={onAdd}>
        {t('isbn.add')}
      </Button>
    );
  } else if (entry.state === 'missing') {
    action = (
      <Button $variant="secondary" $size="small" onClick={onAdd} title={t('isbn.anywayTitle')}>
        {t('isbn.anyway')}
      </Button>
    );
  } else if (entry.state === 'failed') {
    action = (
      <Button $variant="secondary" $size="small" onClick={onRetry}>
        {t('isbn.retry')}
      </Button>
    );
  }

  return (
    <Result>
      {thumbnail ? <img src={thumbnail} alt="" loading="lazy" referrerPolicy="no-referrer" /> : <span className="placeholder" />}
      <div>
        <strong>{book?.title ?? t('isbn.isbnTitle', { isbn: formatIsbn(entry.isbn) })}</strong>
        <Muted>
          {entry.state === 'looking' && t('isbn.looking')}
          {entry.state === 'missing' && t('isbn.unknown')}
          {entry.state === 'failed' && entry.error}
          {details?.filter(Boolean).join(t('common.list'))}
        </Muted>
      </div>
      {action}
    </Result>
  );
}

