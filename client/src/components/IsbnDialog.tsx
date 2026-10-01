import { createItem, type ItemId } from '@nexlibris/common';
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import styled from 'styled-components';
import { formatIsbn, itemsWithIsbn, normalizeIsbn } from '../isbn/isbn';
import { itemFromBook, lookupIsbn, type BookInfo } from '../isbn/openLibrary';
import { cameraAvailable, isbnReader, readIsbnFromImage } from '../isbn/scanner';
import { useLibrary } from '../library/LibraryContext';
import { Button, FileButton, Muted, Row, Spacer } from '../styles/ui';
import { Modal, ModalFooter } from './Modal';

const Viewfinder = styled.div`
  position: relative;
  margin: 16px 0 8px;
  border-radius: var(--radius);
  overflow: hidden;
  background: #000;
  aspect-ratio: 4 / 3;

  video {
    display: block;
    width: 100%;
    height: 100%;
    object-fit: cover;
  }

  /* Where to hold the barcode. */
  &::after {
    content: '';
    position: absolute;
    inset: 30% 12%;
    border: 2px solid var(--highlight);
    border-radius: 8px;
    box-shadow: 0 0 0 100vmax rgb(0 0 0 / 0.25);
  }
`;

const CameraNote = styled(Muted)`
  position: absolute;
  inset: auto 0 8px;
  z-index: 1;
  text-align: center;
  color: #fff;
  font-size: 0.85rem;
  text-shadow: 0 1px 2px #000;
`;

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
      setError(`“${typed.trim()}” isn’t a valid ISBN.`);
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
      if (!found.length) setError('No ISBN barcode found in that picture. Try a closer, sharper one, or type the number.');
      for (const isbn of found) offer(isbn);
    } catch (e) {
      setError(`Couldn’t read that picture: ${errorMessage(e)}`);
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
            : createItem({ title: `ISBN ${formatIsbn(entry.isbn)}`, identifiers: { isbn: entry.isbn } });
        await apply([{ type: 'addItem', item }]);
        setAdded((current) => ({ ...current, [entry.isbn]: item.id }));
      }
    } catch (e) {
      setError(`Couldn’t add the book: ${errorMessage(e)}`);
    } finally {
      setAdding((current) => new Set([...current].filter((isbn) => !isbns.includes(isbn))));
    }
  };

  const inLibrary = (isbn: string) => added[isbn] ?? itemsWithIsbn(library, isbn)[0]?.id;
  const addable = entries.filter((e) => e.state === 'found' && !inLibrary(e.isbn) && !adding.has(e.isbn));

  return (
    <Modal title="Add by ISBN" onClose={onClose}>
      <Muted as="p">
        Scan the barcode on the back of a book, or type its ISBN, to look it up on Open Library and add it to the library
        without a file.
      </Muted>

      {scanning && <Camera onIsbn={offer} onError={(message) => (setError(message), setScanning(false))} />}

      <Controls>
        {cameraAvailable() && (
          <Button $variant={scanning ? 'secondary' : 'primary'} onClick={() => (setError(undefined), setScanning(!scanning))}>
            {scanning ? 'Stop camera' : 'Scan with camera'}
          </Button>
        )}
        <FileButton $variant="secondary">
          Photo of barcode…
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
            placeholder="ISBN, e.g. 978-0-441-17271-9"
            aria-label="ISBN"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
          />
          <Button type="submit" $variant="secondary" disabled={!typed.trim()}>
            Look up
          </Button>
        </form>
      </Controls>

      {error && <ErrorText role="alert">{error}</ErrorText>}

      {entries.length > 0 && (
        <Results aria-label="Books found">
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
        {addable.length > 1 && <Button onClick={() => void add(addable)}>Add all {addable.length}</Button>}
        <Spacer />
        <Button $variant="secondary" onClick={onClose}>
          Close
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
    String(book.metadata.published ?? '').slice(0, 4),
    book.metadata.publisher,
  ];
  const thumbnail = book?.coverUrl?.replace(/-L\.jpg$/, '-M.jpg');

  let action;
  if (existing) {
    action = (
      <Button $variant="secondary" $size="small" onClick={() => onOpen(existing)}>
        {wasAdded ? 'Added · Open' : 'In library · Open'}
      </Button>
    );
  } else if (adding) {
    action = <Muted>Adding…</Muted>;
  } else if (entry.state === 'found') {
    action = (
      <Button $size="small" onClick={onAdd}>
        Add
      </Button>
    );
  } else if (entry.state === 'missing') {
    action = (
      <Button $variant="secondary" $size="small" onClick={onAdd} title="Adds an item with only the ISBN, to fill in yourself">
        Add anyway
      </Button>
    );
  } else if (entry.state === 'failed') {
    action = (
      <Button $variant="secondary" $size="small" onClick={onRetry}>
        Retry
      </Button>
    );
  }

  return (
    <Result>
      {thumbnail ? <img src={thumbnail} alt="" loading="lazy" referrerPolicy="no-referrer" /> : <span className="placeholder" />}
      <div>
        <strong>{book?.title ?? `ISBN ${formatIsbn(entry.isbn)}`}</strong>
        <Muted>
          {entry.state === 'looking' && 'Looking up…'}
          {entry.state === 'missing' && 'Open Library doesn’t know this ISBN.'}
          {entry.state === 'failed' && entry.error}
          {details?.filter(Boolean).join(' · ')}
        </Muted>
      </div>
      {action}
    </Result>
  );
}

/**
 * The camera, read for barcodes several times a second while it's shown. An ISBN counts once
 * two frames in a row agree on it: a blurred or skewed frame can misread as another number
 * whose check digit happens to work.
 */
function Camera({ onIsbn, onError }: { onIsbn(isbn: string): void; onError(message: string): void }) {
  const video = useRef<HTMLVideoElement>(null);
  const [note, setNote] = useState('Starting the camera…');
  const callbacks = useRef({ onIsbn, onError });
  callbacks.current = { onIsbn, onError };

  useEffect(() => {
    let stopped = false;
    let stream: MediaStream | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;

    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } },
          audio: false,
        });
        if (stopped || !video.current) return;
        video.current.srcObject = stream;
        await video.current.play();
        setNote('Loading the barcode reader…');
        const reader = await isbnReader();
        if (stopped) return;
        setNote('Hold the barcode inside the frame.');
        let previous: string[] = [];
        const scan = async () => {
          if (stopped) return;
          const frame = video.current;
          try {
            if (frame && frame.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
              const read = await reader.read(frame);
              for (const isbn of read) if (previous.includes(isbn)) callbacks.current.onIsbn(isbn);
              previous = read;
            }
          } catch {
            // A frame that can't be read (e.g. while the camera settles) is skipped.
          }
          timer = setTimeout(() => void scan(), 150);
        };
        void scan();
      } catch (e) {
        if (stopped) return;
        const name = e instanceof DOMException ? e.name : '';
        callbacks.current.onError(
          name === 'NotAllowedError'
            ? 'Camera access was refused. Allow it in the browser or system settings, or use a photo instead.'
            : name === 'NotFoundError' || name === 'OverconstrainedError'
              ? 'No camera found. Use a photo of the barcode, or type the ISBN.'
              : `Couldn’t start the camera: ${errorMessage(e)}`,
        );
      }
    })();

    return () => {
      stopped = true;
      clearTimeout(timer);
      stream?.getTracks().forEach((track) => track.stop());
    };
  }, []);

  return (
    <Viewfinder>
      <video ref={video} muted playsInline />
      <CameraNote as="p">{note}</CameraNote>
    </Viewfinder>
  );
}
