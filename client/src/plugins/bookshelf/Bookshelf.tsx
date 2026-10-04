import type { Item } from '@nexlibris/common';
import styled, { css } from 'styled-components';
import { clickModifiers, type CollectionProps } from '../../components/LibraryGrid';
import { Cover } from '../../components/Cover';
import { useLongPress } from '../../library/useLongPress';

/**
 * The books as a bookshelf, in CSS 3D: each book a box standing spine out, its title down the spine,
 * that leans out of the shelf on hover (or when selected), showing its cover. Spines are the cover's
 * colour (`coverColor`) and as thick as the book's pages, so far as the library knows them.
 */

/** A shelf's height above its board: room for the tallest book and its lean. */
const ROW = 214;
/** The board, and the space under it before the next shelf's books. */
const BOARD = 12;
const ROW_GAP = 30;

/** Spines for books without a cover colour: muted cloth and leather. */
const BINDINGS = ['#7b2e2e', '#2f4a6b', '#3e5b3a', '#6b4f2a', '#4a3b5c', '#8a6d3b', '#2d5656', '#5c2f45', '#3b3b3b', '#84552f'];

/** A steady number from a string, so a book keeps its size and colour. */
function hash(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** Text that reads on a spine of this colour. */
function inkFor(hex: string): string {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.55 ? '#1d1a16' : '#f6f0e4';
}

export interface BookShape {
  /** Spine height, thickness and the book's depth (its cover's width), in pixels. */
  height: number;
  thickness: number;
  depth: number;
  color: string;
  ink: string;
}

/** How big a book stands and what colour its spine is. Exported for tests. */
export function bookShape(item: Item): BookShape {
  const h = hash(item.id);
  const height = 150 + (h % 47);
  const pages = typeof item.metadata.pages === 'number' ? item.metadata.pages : undefined;
  const thickness = pages ? Math.round(Math.min(52, Math.max(16, pages / 13))) : 20 + ((h >>> 8) % 21);
  const color = item.metadata.coverColor ?? BINDINGS[(h >>> 16) % BINDINGS.length]!;
  return { height, thickness, depth: Math.round(height * 0.68), color, ink: inkFor(color) };
}

const Shelf = styled.ul`
  --board: #8a6440;
  --board-edge: #6b4c30;

  display: flex;
  flex-wrap: wrap;
  align-content: flex-start;
  gap: ${ROW_GAP + BOARD}px 3px;
  margin: 0;
  /* Room for the last shelf's board. */
  padding: 0 12px ${BOARD + 6}px;
  list-style: none;
  user-select: none;
  -webkit-touch-callout: none;
  background: repeating-linear-gradient(
    to bottom,
    transparent 0 ${ROW}px,
    var(--board) ${ROW}px ${ROW + BOARD - 3}px,
    var(--board-edge) ${ROW + BOARD - 3}px ${ROW + BOARD}px,
    color-mix(in srgb, var(--text) 12%, transparent) ${ROW + BOARD}px ${ROW + BOARD + 6}px,
    transparent ${ROW + BOARD + 6}px ${ROW + BOARD + ROW_GAP}px
  );
  border-radius: 2px;
`;

/** A book's place on the shelf: its own perspective, so it's seen straight on until it leans. */
const Slot = styled.li`
  position: relative;
  display: flex;
  align-items: flex-end;
  height: ${ROW}px;
  perspective: 700px;
  perspective-origin: 50% 20%;

  /* A leaning book in front of its neighbours, the one under the pointer in front of all. */
  &:has([aria-pressed='true']) {
    z-index: 1;
  }

  &:hover,
  &:focus-within {
    z-index: 2;
  }
`;

const leaning = css`
  transform: translateZ(26px) rotateX(-9deg) rotateY(-30deg);
`;

const Book = styled.button.attrs({ type: 'button' })<{ $shape: BookShape; $selected: boolean }>`
  position: relative;
  width: ${(p) => p.$shape.thickness}px;
  height: ${(p) => p.$shape.height}px;
  padding: 0;
  border: none;
  background: none;
  color: ${(p) => p.$shape.ink};
  font: inherit;
  cursor: pointer;
  transform-style: preserve-3d;
  transform-origin: 50% 100%;
  transition: transform 0.25s ease;

  &:hover,
  &:focus-visible {
    outline: none;
    ${leaning}
  }

  ${(p) => p.$selected && leaning}

  @media (prefers-reduced-motion: reduce) {
    transition: none;
  }
`;

const face = css`
  position: absolute;
  backface-visibility: hidden;
`;

const Spine = styled.span<{ $shape: BookShape; $selected: boolean }>`
  ${face}
  inset: 0;
  /* Written down the spine, so the flex row runs top to bottom: the title, then the author. */
  display: flex;
  flex-direction: row;
  align-items: center;
  gap: 6px;
  padding: 10px 0 8px;
  overflow: hidden;
  border-radius: 2px 2px 0 0;
  background:
    linear-gradient(90deg, rgb(0 0 0 / 0.28), rgb(255 255 255 / 0.14) 28%, rgb(0 0 0 / 0) 55%, rgb(0 0 0 / 0.22)),
    ${(p) => p.$shape.color};
  box-shadow: ${(p) => (p.$selected ? 'inset 0 0 0 2px var(--highlight)' : 'inset 0 -2px 0 rgb(0 0 0 / 0.25)')};
  writing-mode: vertical-rl;
  font-family: Georgia, serif;
  font-size: ${(p) => Math.min(12, Math.round(p.$shape.thickness * 0.48))}px;
  line-height: 1.1;
  text-align: start;
`;

const SpineTitle = styled.span`
  flex: 0 1 auto;
  min-inline-size: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  font-weight: 600;
`;

const SpineAuthor = styled.span`
  flex-shrink: 0;
  max-inline-size: 38%;
  margin-inline-start: auto;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  font-size: 0.85em;
  opacity: 0.8;
`;

/** The front cover, at the spine's right edge, going back into the shelf. */
const Front = styled.span<{ $shape: BookShape }>`
  ${face}
  top: 0;
  left: ${(p) => p.$shape.thickness}px;
  width: ${(p) => p.$shape.depth}px;
  height: 100%;
  overflow: hidden;
  background: ${(p) => p.$shape.color};
  transform-origin: 0 50%;
  transform: rotateY(90deg);
`;

const FrontCover = styled(Cover)`
  height: 100%;
  aspect-ratio: auto;
  border-radius: 0;
  box-shadow: none;
`;

/** The back cover, at the spine's left edge. */
const Back = styled.span<{ $shape: BookShape }>`
  ${face}
  top: 0;
  right: 100%;
  width: ${(p) => p.$shape.depth}px;
  height: 100%;
  background: linear-gradient(rgb(0 0 0 / 0.3), rgb(0 0 0 / 0.3)), ${(p) => p.$shape.color};
  transform-origin: 100% 50%;
  transform: rotateY(-90deg);
`;

/** The pages' top edge. */
const Top = styled.span<{ $shape: BookShape }>`
  ${face}
  bottom: 100%;
  left: 0;
  width: 100%;
  height: ${(p) => p.$shape.depth}px;
  background: repeating-linear-gradient(90deg, #efe6d2 0 2px, #ddd2b8 2px 3px);
  transform-origin: 50% 100%;
  transform: rotateX(90deg);
`;

export function Bookshelf({ items, selection, onActivate, onLongPress }: CollectionProps) {
  const longPress = useLongPress(onLongPress);
  return (
    <Shelf aria-label="Bookshelf">
      {items.map((item) => {
        const shape = bookShape(item);
        const selected = selection.has(item.id);
        const authors = item.creators.filter((c) => c.role === 'aut').map((c) => c.name);
        const byline = (authors.length ? authors : item.creators.map((c) => c.name)).join(', ');
        return (
          <Slot key={item.id}>
            <Book
              $shape={shape}
              $selected={selected}
              aria-pressed={selected}
              aria-label={byline ? `${item.title}, ${byline}` : item.title}
              title={byline ? `${item.title} — ${byline}` : item.title}
              onClick={(e) => onActivate(item.id, clickModifiers(e))}
              {...longPress(item.id)}
            >
              <Spine $shape={shape} $selected={selected} aria-hidden>
                <SpineTitle>{item.title}</SpineTitle>
                {byline && shape.thickness >= 24 && <SpineAuthor>{byline}</SpineAuthor>}
              </Spine>
              <Front $shape={shape} aria-hidden>
                <FrontCover item={item} />
              </Front>
              <Back $shape={shape} aria-hidden />
              <Top $shape={shape} aria-hidden />
            </Book>
          </Slot>
        );
      })}
    </Shelf>
  );
}
