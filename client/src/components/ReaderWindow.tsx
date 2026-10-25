import { useCallback, useEffect, useState } from 'react';
import { followTitleBar } from '../backends/desktopBridge';
import { requestBook, type ReaderAddress, type ReaderBook } from '../library/readerWindow';
import { usePositionReports } from '../library/useReadingPosition';
import { BookReader } from '../reader/Reader';
import { Status } from '../styles/ui';
import { t } from '../i18n';

/**
 * A book in a window of its own (see `library/readerWindow.ts`): the reader alone, filling the
 * window, with the book from the library's window rather than a library of its own. Closing the
 * reader closes the window.
 */
export function ReaderWindow({ itemId, hash, at }: ReaderAddress) {
  const [opened, setOpened] = useState<{ book: ReaderBook; sendPosition: Sender }>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    const request = requestBook({ itemId, hash });
    let cancelled = false;
    request.book.then(
      (book) => !cancelled && setOpened({ book, sendPosition: request.sendPosition }),
      (e: unknown) => !cancelled && setError(e instanceof Error ? e.message : String(e)),
    );
    return () => {
      cancelled = true;
      request.close();
    };
  }, [itemId, hash]);
  useEffect(() => followTitleBar(), []);

  if (error) return <Status $error>{error}</Status>;
  if (!opened) return <Status>{t('common.opening')}</Status>;
  return <OpenBook book={opened.book} at={at} sendPosition={opened.sendPosition} />;
}

type Sender = (book: ReaderBook, locator: string, progress?: number) => void;

function OpenBook({
  book,
  at,
  sendPosition,
}: {
  book: ReaderBook;
  at: string | undefined;
  sendPosition: Sender;
}) {
  const report = usePositionReports(
    useCallback((locator: string, progress?: number) => sendPosition(book, locator, progress), [book, sendPosition]),
    book.position,
  );
  const load = useCallback(async () => book.data, [book]);
  const position = at ?? book.position;
  return (
    <BookReader
      title={book.title}
      file={book.file}
      load={load}
      {...(position !== undefined && { position })}
      onPosition={report}
      onClose={() => window.close()}
    />
  );
}
