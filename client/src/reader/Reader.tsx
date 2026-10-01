import type { FileRef, Item } from '@nexlibris/common';
import { lazy, Suspense, useEffect, useState, type ComponentType } from 'react';
import styled from 'styled-components';
import { FORMATS, isFormatId, READ_PREFERENCE, type FormatId } from '../formats/formats';
import { useLibrary } from '../library/LibraryContext';
import { useReadingPosition } from '../library/useReadingPosition';
import { LockScroll } from '../styles/GlobalStyle';
import { Button, Muted, Status } from '../styles/ui';

const Shell = styled.div`
  position: fixed;
  inset: 0;
  z-index: 20;
  display: flex;
  flex-direction: column;
  background: var(--bg);
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
  options: { forcePdfjs: boolean };
}

const EpubViewer = lazy(() => import('./EpubViewer'));
const PdfViewer = lazy(() => import('./PdfViewer'));
const ComicViewer = lazy(() => import('./ComicViewer'));
const PlainTextViewer = lazy(() => import('./TextViewer').then((m) => ({ default: m.PlainTextViewer })));
const RtfViewer = lazy(() => import('./TextViewer').then((m) => ({ default: m.RtfViewer })));

const VIEWERS: Partial<Record<FormatId, ComponentType<ViewerProps>>> = {
  epub: EpubViewer,
  'x4.epub': EpubViewer,
  'x3.epub': EpubViewer,
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
  onClose(): void;
}

/** A full-window reader for one of an item's files. */
export function Reader({ item, file, onClose }: Props) {
  const { backend } = useLibrary();
  const { initial: position, report: onPosition } = useReadingPosition(item.id, file);
  const [data, setData] = useState<Blob | null>();
  const [forcePdfjs, setForcePdfjs] = useState(false);
  const format = isFormatId(file.format) ? file.format : undefined;
  // epubier has its own toolbar and uses Escape for its menus.
  const ownChrome = format === 'epub' || format === 'x4.epub' || format === 'x3.epub';

  useEffect(() => {
    let cancelled = false;
    void backend.getFile(file.hash).then((blob) => !cancelled && setData(blob ?? null));
    return () => {
      cancelled = true;
    };
  }, [backend, file.hash]);

  useEffect(() => {
    if (ownChrome) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [ownChrome, onClose]);

  useEffect(() => {
    const previous = document.title;
    document.title = `${item.title} · nexlibris`;
    return () => {
      document.title = previous;
    };
  }, [item.title]);

  const Viewer = format && VIEWERS[format];
  const body =
    data === undefined ? (
      <Status>Opening…</Status>
    ) : data === null ? (
      <Status $error>This file is missing from storage.</Status>
    ) : !Viewer ? (
      <Status>There’s no viewer for {file.format} files yet.</Status>
    ) : (
      <Suspense fallback={<Status>Loading viewer…</Status>}>
        <Viewer
          data={data}
          format={format}
          storageKey={`nexlibris:${file.hash}`}
          position={position}
          onPosition={onPosition}
          onClose={onClose}
          options={{ forcePdfjs }}
        />
      </Suspense>
    );

  if (ownChrome && data) {
    return (
      <Shell>
        <LockScroll />
        {body}
      </Shell>
    );
  }
  return (
    <Shell role="dialog" aria-label={`Reading ${item.title}`}>
      <LockScroll />
      <Bar>
        <Button $variant="secondary" onClick={onClose}>
          ← Back
        </Button>
        <Title>{item.title}</Title>
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
