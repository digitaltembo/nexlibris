import type { FileRef, Item, WindowColors } from '@nexlibris/common';
import { lazy, Suspense, useCallback, useEffect, useState, type ComponentType } from 'react';
import styled from 'styled-components';
import { EPUB_FORMATS, FORMATS, isEpub, isFormatId, READ_PREFERENCE, type FormatId } from '@nexlibris/tools/formats/formats';
import { useLibrary } from '../library/LibraryContext';
import { useReadingPosition } from '../library/useReadingPosition';
import { LockScroll } from '../styles/GlobalStyle';
import { Button, Muted, Status } from '../styles/ui';
import { setReaderColors } from '../styles/windowColors';

const Shell = styled.div`
  position: fixed;
  inset: 0;
  z-index: 20;
  display: flex;
  flex-direction: column;
  padding: var(--title-bar-height, 0px) var(--safe-right, 0px) var(--safe-bottom, 0px) var(--safe-left, 0px);
  background: var(--bg);

  /* Without a title bar (the desktop app on macOS), a strip above the reader holds the window
     buttons and moves the window. data-covers-window keeps the top bar beneath from taking it. */
  &::before {
    content: '';
    position: absolute;
    inset: 0 0 auto;
    height: var(--title-bar-height, 0px);
    -webkit-app-region: drag;
  }
`;

const Bar = styled.header`
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 16px;
  border-bottom: 1px solid var(--border);
`;

const Title = styled.span`
  flex: 1;
  overflow: hidden;
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
`;

const Body = styled.div`
  flex: 1;
  min-height: 0;
  overflow: auto;
`;

export interface ViewerProps {
  data: Blob;
  format: FormatId;
  /** Stable per file, for viewers that keep their own data (epubier: page counts, bookmarks). */
  storageKey: string;
  /** Where to open: a locator this viewer reported for this file before. */
  position?: string;
  /** Reports where the reader is, as often as it likes; saving is debounced. */
  onPosition?(locator: string, progress?: number): void;
  onClose(): void;
  /** The viewer's own colours (epubier's themes), for what's around it: the title bar strip, the system bars. */
  onColors?(colors: WindowColors): void;
  options: { forcePdfjs: boolean };
}

const EpubViewer = lazy(() => import('./EpubViewer'));
const PdfViewer = lazy(() => import('./PdfViewer'));
const ComicViewer = lazy(() => import('./ComicViewer'));
const PlainTextViewer = lazy(() => import('./TextViewer').then((m) => ({ default: m.PlainTextViewer })));
const RtfViewer = lazy(() => import('./TextViewer').then((m) => ({ default: m.RtfViewer })));

const VIEWERS: Partial<Record<FormatId, ComponentType<ViewerProps>>> = {
  ...Object.fromEntries(EPUB_FORMATS.map((format) => [format, EpubViewer])),
  pdf: PdfViewer,
  cbz: ComicViewer,
  cbr: ComicViewer,
  txt: PlainTextViewer,
  rtf: RtfViewer,
};

export function isReadable(file: FileRef): boolean {
  return isFormatId(file.format) && VIEWERS[file.format] !== undefined;
}

/** The file "Read" opens: the best format the item has a viewer for. */
export function preferredReadable(item: Item): FileRef | undefined {
  const rank = (f: FileRef) => READ_PREFERENCE.indexOf(f.format as FormatId);
  return item.files.filter(isReadable).sort((a, b) => rank(a) - rank(b))[0];
}

interface Props {
  item: Item;
  file: FileRef;
  /** Where to open instead of where the reader left off, e.g. a passage a text search found. */
  at?: string;
  onClose(): void;
}

/** A full-window reader for one of an item's files, over the library: its file, and where the reader left off. */
export function Reader({ item, file, at, onClose }: Props) {
  const { backend } = useLibrary();
  const { initial, report } = useReadingPosition(item.id, file);
  const load = useCallback(() => backend.getFile(file.hash), [backend, file.hash]);
  const position = at ?? initial;
  return (
    <BookReader
      title={item.title}
      file={file}
      load={load}
      {...(position !== undefined && { position })}
      onPosition={report}
      onClose={onClose}
    />
  );
}

export interface BookReaderProps {
  title: string;
  file: FileRef;
  /** The file's contents; undefined if they're missing. A file left on the sync hub is fetched first, which can fail. */
  load(): Promise<Blob | undefined>;
  /** Where to open. */
  position?: string;
  onPosition(locator: string, progress?: number): void;
  onClose(): void;
}

/**
 * The reader itself, needing only the book: its title, its file and contents, and where to open,
 * with where the reader moves reported. `Reader` gives it these from the library; a book's own
 * window, from the library's window (`components/ReaderWindow.tsx`).
 */
export function BookReader({ title, file, load, position, onPosition, onClose }: BookReaderProps) {
  const [data, setData] = useState<Blob | null>();
  const [fetchError, setFetchError] = useState<string>();
  const [forcePdfjs, setForcePdfjs] = useState(false);
  const [colors, setColors] = useState<WindowColors>();
  const format = isFormatId(file.format) ? file.format : undefined;
  // epubier has its own toolbar and uses Escape for its menus.
  const ownChrome = !!format && isEpub(format);

  useEffect(() => {
    let cancelled = false;
    load().then(
      (blob) => !cancelled && setData(blob ?? null),
      (e: unknown) => {
        if (cancelled) return;
        setFetchError(e instanceof Error ? e.message : String(e));
        setData(null);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [load]);

  useEffect(() => {
    if (ownChrome) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [ownChrome, onClose]);

  useEffect(() => {
    setReaderColors(colors);
    return () => setReaderColors(undefined);
  }, [colors]);

  useEffect(() => {
    const previous = document.title;
    document.title = `${title} · nexlibris`;
    return () => {
      document.title = previous;
    };
  }, [title]);

  const Viewer = format && VIEWERS[format];
  const body =
    data === undefined ? (
      <Status>Opening…</Status>
    ) : data === null ? (
      <Status $error>{fetchError ?? 'This file is missing from storage.'}</Status>
    ) : !Viewer ? (
      <Status>There’s no viewer for {file.format} files yet.</Status>
    ) : (
      <Suspense fallback={<Status>Loading viewer…</Status>}>
        <Viewer
          data={data}
          format={format}
          storageKey={`nexlibris:${file.hash}`}
          {...(position !== undefined && { position })}
          onPosition={onPosition}
          onClose={onClose}
          onColors={setColors}
          options={{ forcePdfjs }}
        />
      </Suspense>
    );

  if (ownChrome && data) {
    return (
      <Shell data-covers-window {...(colors && { style: { background: colors.background } })}>
        <LockScroll />
        {body}
      </Shell>
    );
  }
  return (
    <Shell data-covers-window role="dialog" aria-label={`Reading ${title}`}>
      <LockScroll />
      <Bar>
        <Button $variant="secondary" onClick={onClose}>
          ← Back
        </Button>
        <Title>{title}</Title>
        {format === 'pdf' && navigator.pdfViewerEnabled && (
          <Button $variant="secondary" onClick={() => setForcePdfjs((f) => !f)}>
            {forcePdfjs ? 'Use built-in viewer' : 'Use pdf.js'}
          </Button>
        )}
        <Muted>{format ? FORMATS[format].label : file.format}</Muted>
      </Bar>
      <Body>{body}</Body>
    </Shell>
  );
}
