import type { Item } from '@nexlibris/common';
import { useEffect, useState } from 'react';
import styled, { css } from 'styled-components';
import { useThumbnailUrl } from '../library/useFileUrl';

const frame = css`
  display: block;
  width: 100%;
  aspect-ratio: 2 / 3;
  border-radius: 4px;
  background: var(--surface);
  box-shadow: 0 1px 3px rgb(0 0 0 / 0.15);
`;

const Image = styled.img`
  ${frame}
  object-fit: cover;
`;

/** `$color`: the cover's colour, filling the frame while the cover loads. */
const Placeholder = styled.div<{ $color?: string | undefined }>`
  ${frame}
  ${(p) => p.$color && `background: ${p.$color};`}
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 12px;
  text-align: center;
  font-family: Georgia, serif;
  color: var(--muted);
  border: 1px solid var(--border);
  overflow: hidden;
`;

/** The title on a placeholder cover; hide it with `${PlaceholderTitle} { display: none }` at small sizes. */
export const PlaceholderTitle = styled.span`
  display: -webkit-box;
  -webkit-line-clamp: 5;
  -webkit-box-orient: vertical;
  overflow: hidden;
`;

/** How far outside the viewport covers are loaded ahead of scrolling, and kept. */
const NEAR = '800px';

/**
 * Whether an element is near the viewport. Off-screen covers are let go of, so a long library
 * holds only the covers around what's shown. True where it can't be told (no IntersectionObserver).
 */
function useNearViewport(element: Element | null): boolean {
  const [near, setNear] = useState(typeof IntersectionObserver === 'undefined');
  useEffect(() => {
    if (!element || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(([entry]) => setNear(!!entry?.isIntersecting), { rootMargin: NEAR });
    observer.observe(element);
    return () => observer.disconnect();
  }, [element]);
  return near;
}

/**
 * An item's cover (its thumbnail, see `library/thumbnails.ts`), loaded when it's near the
 * viewport, or a placeholder showing `label` (else its title). Without an item, just the
 * placeholder. Pass `className` (e.g. via `styled(Cover)`) to size it.
 */
export function Cover({ item, label, className }: { item?: Item; label?: string; className?: string }) {
  const [element, setElement] = useState<Element | null>(null);
  const near = useNearViewport(element);
  const url = useThumbnailUrl(near ? item?.cover : undefined);
  if (url) return <Image ref={setElement} className={className} src={url} alt="" />;
  // A cover still to load is an empty frame rather than a title that flashes up.
  const waiting = item?.cover && url !== null;
  return (
    <Placeholder ref={setElement} className={className} $color={waiting ? item?.metadata.coverColor : undefined} aria-hidden>
      {!waiting && <PlaceholderTitle>{label ?? item?.title}</PlaceholderTitle>}
    </Placeholder>
  );
}
