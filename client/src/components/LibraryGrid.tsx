import { userData, type Item, type ItemId } from '@nexlibris/common';
import type { MouseEvent } from 'react';
import styled, { css } from 'styled-components';
import { useLibrary } from '../library/LibraryContext';
import { NARROW } from '../styles/GlobalStyle';
import { Badge } from '../styles/ui';
import { Cover } from './Cover';
import { StarRating } from './StarRating';

/** Shared by the grid and list views. */
export interface CollectionProps {
  items: Item[];
  /** The item open in the detail panel. */
  activeId: ItemId | undefined;
  selecting: boolean;
  selection: ReadonlySet<ItemId>;
  onActivate(id: ItemId, event: { shiftKey: boolean; metaKey: boolean; ctrlKey: boolean }): void;
}

export const clickModifiers = (e: MouseEvent) => ({ shiftKey: e.shiftKey, metaKey: e.metaKey, ctrlKey: e.ctrlKey });

const Grid = styled.ul<{ $selecting: boolean }>`
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
  gap: 16px;
  margin: 0;
  padding: 0;
  list-style: none;
  ${(p) => p.$selecting && 'user-select: none;'}

  ${NARROW} {
    grid-template-columns: repeat(auto-fill, minmax(110px, 1fr));
    gap: 10px;
  }
`;

const Card = styled.button.attrs({ type: 'button' })<{ $active: boolean }>`
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: 2px;
  width: 100%;
  padding: 6px;
  border: none;
  border-radius: var(--radius);
  background: ${(p) => (p.$active ? 'var(--soft)' : 'none')};
  color: inherit;
  text-align: left;

  &:hover {
    background: ${(p) => (p.$active ? 'var(--soft)' : 'var(--hover)')};
  }
`;

const CoverFrame = styled.span`
  position: relative;
`;

const CardCover = styled(Cover)<{ $selected: boolean }>`
  ${(p) =>
    p.$selected &&
    css`
      outline: 3px solid var(--accent);
      outline-offset: 2px;
    `}
`;

const Check = styled.span<{ $selected: boolean }>`
  position: absolute;
  top: 6px;
  left: 6px;
  display: grid;
  place-items: center;
  width: 22px;
  height: 22px;
  border-radius: 50%;
  border: 2px solid #fff;
  background: ${(p) => (p.$selected ? 'var(--accent)' : 'rgb(0 0 0 / 0.35)')};
  color: #fff;
  font-size: 13px;
  font-weight: 700;
  box-shadow: 0 1px 3px rgb(0 0 0 / 0.4);
`;

const CardTitle = styled.span`
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  margin-top: 6px;
  font-weight: 600;
`;

const Creators = styled.span`
  overflow: hidden;
  color: var(--muted);
  font-size: 0.9em;
  white-space: nowrap;
  text-overflow: ellipsis;
`;

const Footer = styled.span`
  display: flex;
  gap: 6px;
  align-items: center;
  min-height: 1.4em;
`;

export function LibraryGrid({ items, activeId, selecting, selection, onActivate }: CollectionProps) {
  const { library } = useLibrary();
  const { ratings } = userData(library);

  return (
    <Grid $selecting={selecting}>
      {items.map((item) => {
        const selected = selection.has(item.id);
        return (
          <li key={item.id}>
            <Card
              $active={item.id === activeId && !selecting}
              aria-pressed={selecting ? selected : undefined}
              onClick={(e) => onActivate(item.id, clickModifiers(e))}
            >
              <CoverFrame>
                <CardCover item={item} $selected={selected} />
                {selecting && (
                  <Check $selected={selected} aria-hidden>
                    {selected ? '✓' : ''}
                  </Check>
                )}
              </CoverFrame>
              <CardTitle>{item.title}</CardTitle>
              <Creators>{item.creators.map((c) => c.name).join(', ')}</Creators>
              <Footer>
                <StarRating value={ratings[item.id]} />
                {item.files.length === 0 && <Badge>no file</Badge>}
              </Footer>
            </Card>
          </li>
        );
      })}
    </Grid>
  );
}
