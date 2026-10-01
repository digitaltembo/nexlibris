import type { Item } from '@nexlibris/common';
import styled, { css } from 'styled-components';
import { useFileUrl } from '../library/useFileUrl';

const frame = css`
  display: block;
  width: 100%;
  aspect-ratio: 2 / 3;
  border-radius: 4px;
  background: var(--surface-2);
  box-shadow: 0 1px 3px rgb(0 0 0 / 0.15);
`;

const Image = styled.img`
  ${frame}
  object-fit: cover;
`;

const Placeholder = styled.div`
  ${frame}
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

/** Pass `className` (e.g. via `styled(Cover)`) to size it. */
export function Cover({ item, className }: { item: Item; className?: string }) {
  const url = useFileUrl(item.cover?.hash, item.cover?.mediaType);
  if (url) return <Image className={className} src={url} alt="" />;
  return (
    <Placeholder className={className} aria-hidden>
      <PlaceholderTitle>{item.title}</PlaceholderTitle>
    </Placeholder>
  );
}
