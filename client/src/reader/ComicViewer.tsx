import { useCallback, useEffect, useRef, useState } from 'react';
import styled from 'styled-components';
import { openComic, type Comic } from '@nexlibris/tools/formats/comic';
import { Status } from '../styles/ui';

const Shell = styled.div`
  display: flex;
  flex-direction: column;
  height: 100%;
  background: #111;
`;

const PageArea = styled.div`
  position: relative;
  display: flex;
  flex: 1;
  justify-content: center;
  min-height: 0;

  img {
    max-width: 100%;
    max-height: 100%;
    object-fit: contain;
  }
`;

/** Invisible halves of the page: click the left to go back, the right to go forward. */
const Zone = styled.button.attrs({ type: 'button' })<{ $side: 'prev' | 'next' }>`
  position: absolute;
  top: 0;
  bottom: 0;
  ${(p) => (p.$side === 'prev' ? 'left: 0; cursor: w-resize;' : 'right: 0; cursor: e-resize;')}
  width: 50%;
  border: none;
  background: none;
`;

const Controls = styled.div`
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 16px;
  color: #ddd;

  input {
    flex: 1;
    padding: 0;
  }
`;
import type { ViewerProps } from './Reader';
import { useObjectUrl } from './useObjectUrl';

export default function ComicViewer({ data, format, position, onPosition }: ViewerProps) {
  const [comic, setComic] = useState<Comic>();
  const [error, setError] = useState<string>();
  // The locator is the page index.
  const [index, setIndex] = useState(() => Math.max(0, Math.floor(Number(position)) || 0));
  const onPositionRef = useRef(onPosition);
  onPositionRef.current = onPosition;
  const [image, setImage] = useState<Blob>();
  const url = useObjectUrl(image);

  useEffect(() => {
    let cancelled = false;
    openComic(format as 'cbz' | 'cbr', data)
      .then((c) => !cancelled && setComic(c))
      .catch((e: unknown) => !cancelled && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      cancelled = true;
    };
  }, [data, format]);

  const pageCount = comic?.pages.length ?? 0;
  const current = Math.min(index, Math.max(pageCount - 1, 0));

  useEffect(() => {
    if (!comic?.pages[current]) return;
    let cancelled = false;
    void comic.pages[current].load().then((blob) => !cancelled && setImage(blob));
    void comic.pages[current + 1]?.load(); // warm the next page
    onPositionRef.current?.(String(current), (current + 1) / comic.pages.length);
    return () => {
      cancelled = true;
    };
  }, [comic, current]);

  const go = useCallback(
    (delta: number) => setIndex((i) => Math.max(0, Math.min(pageCount - 1, Math.min(i, pageCount - 1) + delta))),
    [pageCount],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement) return;
      if (['ArrowRight', 'PageDown', ' '].includes(e.key)) go(1);
      else if (['ArrowLeft', 'PageUp'].includes(e.key)) go(-1);
      else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [go]);

  if (error) return <Status $error>{error}</Status>;
  if (!comic) return <Status>Opening comic…</Status>;
  if (pageCount === 0) return <Status>This comic has no pages.</Status>;

  return (
    <Shell>
      <PageArea>
        {url && <img src={url} alt={`Page ${current + 1}`} />}
        <Zone $side="prev" aria-label="Previous page" onClick={() => go(-1)} />
        <Zone $side="next" aria-label="Next page" onClick={() => go(1)} />
      </PageArea>
      <Controls>
        <input
          type="range"
          min={1}
          max={pageCount}
          value={current + 1}
          aria-label="Page"
          onChange={(e) => setIndex(Number(e.target.value) - 1)}
        />
        <span>
          {current + 1} / {pageCount}
        </span>
      </Controls>
    </Shell>
  );
}
