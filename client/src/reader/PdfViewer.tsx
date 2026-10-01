import { useEffect, useMemo, useRef, useState } from 'react';
import styled from 'styled-components';
import { loadPdfjs } from '../formats/pdf';
import { Status } from '../styles/ui';

const Frame = styled.iframe`
  display: block;
  width: 100%;
  height: 100%;
  border: none;
`;

const Pages = styled.div`
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 16px;
  padding: 16px;
`;

const Page = styled.canvas`
  width: min(100%, 1000px);
  background: #fff;
  box-shadow: 0 1px 4px rgb(0 0 0 / 0.2);
`;
import type { ViewerProps } from './Reader';
import { scrollParent } from './scroll';
import { useObjectUrl } from './useObjectUrl';

/** The browser's own PDF viewer where there is one; pdf.js otherwise (e.g. Android Chrome). */
export default function PdfViewer({ data, options, position, onPosition }: ViewerProps) {
  // The built-in viewer is a sandboxed frame, so its position can't be followed.
  if (navigator.pdfViewerEnabled && !options.forcePdfjs) return <BuiltinPdfViewer data={data} />;
  return <PdfJsViewer data={data} position={position} onPosition={onPosition} />;
}

function BuiltinPdfViewer({ data }: { data: Blob }) {
  // The built-in viewer needs the media type; stored files don't carry one.
  const pdf = useMemo(() => (data.type === 'application/pdf' ? data : new Blob([data], { type: 'application/pdf' })), [data]);
  const url = useObjectUrl(pdf);
  return url ? <Frame src={url} title="PDF" /> : null;
}

type PdfDocument = Awaited<ReturnType<Awaited<ReturnType<typeof loadPdfjs>>['getDocument']>['promise']>;

function PdfJsViewer({ data, position, onPosition }: Pick<ViewerProps, 'data' | 'position' | 'onPosition'>) {
  const [doc, setDoc] = useState<PdfDocument>();
  const [error, setError] = useState<string>();
  const pagesRef = useRef<HTMLDivElement>(null);
  const onPositionRef = useRef(onPosition);
  onPositionRef.current = onPosition;

  // The locator is the 1-based page number at the top of the screen. Pages are
  // placeholders until rendered, so a page number holds up where a scroll offset wouldn't.
  useEffect(() => {
    const container = pagesRef.current;
    if (!doc || !container) return;
    const pages = () => [...container.querySelectorAll('canvas')];
    const target = Math.floor(Number(position));
    if (target > 1) pages()[Math.min(target, doc.numPages) - 1]?.scrollIntoView();
    const scroller = scrollParent(container);
    const onScroll = () => {
      const top = scroller.getBoundingClientRect().top;
      const index = pages().findIndex((page) => page.getBoundingClientRect().bottom > top + 1);
      const page = (index < 0 ? doc.numPages - 1 : index) + 1;
      onPositionRef.current?.(String(page), page / doc.numPages);
    };
    scroller.addEventListener('scroll', onScroll, { passive: true });
    return () => scroller.removeEventListener('scroll', onScroll);
  }, [doc, position]);

  useEffect(() => {
    let task: { destroy(): Promise<void> } | undefined;
    let cancelled = false;
    void (async () => {
      try {
        const pdfjs = await loadPdfjs();
        const buffer = new Uint8Array(await data.arrayBuffer());
        if (cancelled) return;
        const loading = pdfjs.getDocument({ data: buffer });
        task = loading;
        const loaded = await loading.promise;
        if (!cancelled) setDoc(loaded);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
      void task?.destroy();
    };
  }, [data]);

  if (error) return <Status $error>{error}</Status>;
  if (!doc) return <Status>Opening PDF…</Status>;
  return (
    <Pages ref={pagesRef}>
      {Array.from({ length: doc.numPages }, (_, i) => (
        <PdfPage key={i} doc={doc} pageNumber={i + 1} />
      ))}
    </Pages>
  );
}

/** Renders a page to a canvas once it scrolls near the viewport, sized to the column width. */
function PdfPage({ doc, pageNumber }: { doc: PdfDocument; pageNumber: number }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [aspect, setAspect] = useState(1.414);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let cancelled = false;
    let renderTask: { cancel(): void } | undefined;

    const render = async () => {
      const page = await doc.getPage(pageNumber);
      if (cancelled) return;
      const unscaled = page.getViewport({ scale: 1 });
      setAspect(unscaled.height / unscaled.width);
      const scale = (canvas.clientWidth * devicePixelRatio) / unscaled.width;
      const viewport = page.getViewport({ scale });
      canvas.width = Math.round(viewport.width);
      canvas.height = Math.round(viewport.height);
      const task = page.render({ canvas, viewport });
      renderTask = task;
      await task.promise.catch(() => undefined);
    };

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          observer.disconnect();
          void render();
        }
      },
      { rootMargin: '100% 0px' },
    );
    observer.observe(canvas);
    return () => {
      cancelled = true;
      observer.disconnect();
      renderTask?.cancel();
    };
  }, [doc, pageNumber]);

  return <Page ref={canvasRef} style={{ aspectRatio: `1 / ${aspect}` }} aria-label={`Page ${pageNumber}`} />;
}
