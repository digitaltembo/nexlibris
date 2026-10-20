import type { Item } from '@nexlibris/common';
import { useEffect, useState } from 'react';
import styled, { css } from 'styled-components';
import { generateCover } from '../library/generateCover';
import { useThumbnailUrl } from '../library/useFileUrl';
import { useCatalogImage } from '../catalogs/useCatalogImage';
import { useCollectionDecor } from './CollectionDecor';

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
  // A catalog's book: its image on the catalog's server, loaded as stored covers are.
  const { coverUrl, fetchImage } = useCollectionDecor();
  const remote = item && coverUrl?.(item);
  const remoteSrc = useCatalogImage(remote, fetchImage, near);
  const [remoteFailed, setRemoteFailed] = useState<string>();
  if (remote && remote !== remoteFailed && remoteSrc !== null) {
    return remoteSrc ? (
      <Image ref={setElement} className={className} src={remoteSrc} alt="" referrerPolicy="no-referrer" onError={() => setRemoteFailed(remote)} />
    ) : (
      <Placeholder ref={setElement} className={className} aria-hidden />
    );
  }
  if (url) return <Image ref={setElement} className={className} src={url} alt="" />;
  // A cover still to load is an empty frame rather than a title that flashes up.
  const waiting = item?.cover && url !== null;
  return (
    <Placeholder ref={setElement} className={className} $color={waiting ? item?.metadata.coverColor : undefined} aria-hidden>
      {!waiting && <PlaceholderTitle>{label ?? item?.title}</PlaceholderTitle>}
    </Placeholder>
  );
}

/** Generated covers by name, as object URLs: each drawn once. */
const generated = new Map<string, Promise<string | undefined>>();

/** A random number source seeded by `text`, so a name always gets the same colours. */
function seeded(text: string): () => number {
  let state = 0;
  for (const char of text) state = (Math.imul(state, 31) + char.charCodeAt(0)) | 0;
  return () => {
    state = (Math.imul(state ^ (state >>> 15), 0x2c1b3c6d) + 0x6d2b79f5) | 0;
    return ((state >>> 0) % 1_000_000) / 1_000_000;
  };
}

/**
 * A cover drawn for a name (`library/generateCover.ts`, the name on a muted colour, the same each
 * time), for a group with no real cover to show: a catalog's place. Drawn once it's near the
 * viewport; the plain placeholder where it can't be (no canvas).
 */
export function GeneratedCover({ title, className }: { title: string; className?: string }) {
  const [element, setElement] = useState<Element | null>(null);
  const near = useNearViewport(element);
  const [url, setUrl] = useState<string>();
  useEffect(() => {
    if (!near) return;
    let cancelled = false;
    let made = generated.get(title);
    if (!made) {
      made = generateCover({ title, creators: [] }, seeded(title)).then(
        (cover) => URL.createObjectURL(cover.data),
        () => undefined,
      );
      generated.set(title, made);
    }
    void made.then((made) => !cancelled && setUrl(made));
    return () => {
      cancelled = true;
    };
  }, [near, title]);
  if (url) return <Image ref={setElement} className={className} src={url} alt="" />;
  return (
    <Placeholder ref={setElement} className={className} aria-hidden>
      <PlaceholderTitle>{title}</PlaceholderTitle>
    </Placeholder>
  );
}
