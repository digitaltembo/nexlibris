import { useCollectionDecor } from './CollectionDecor';
import { userData, type Item, type ItemId } from '@nexlibris/common';
import type { MouseEvent } from 'react';
import styled from 'styled-components';
import { useLibrary } from '../library/LibraryContext';
import { useLongPress } from '../library/useLongPress';
import { NARROW } from '../styles/GlobalStyle';
import { Badge } from '../styles/ui';
import { Cover } from './Cover';
import { StarRating } from './StarRating';

/** Shared by the grid and list views. */
export interface CollectionProps {
  items: Item[];
  /** The selected items, shown highlighted (see `library/selection.ts`). */
  selection: ReadonlySet<ItemId>;
  onActivate(id: ItemId, event: { shiftKey: boolean; metaKey: boolean; ctrlKey: boolean }): void;
  /** A long press on a touch screen: adds the item to the selection, or takes it away. */
  onLongPress(id: ItemId): void;
}

export const clickModifiers = (e: MouseEvent) => ({ shiftKey: e.shiftKey, metaKey: e.metaKey, ctrlKey: e.ctrlKey });

const Grid = styled.ul`
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
  gap: 16px;
  margin: 0;
  padding: 0;
  list-style: none;
  user-select: none;
  -webkit-touch-callout: none;

  ${NARROW} {
    grid-template-columns: repeat(auto-fill, minmax(110px, 1fr));
    gap: 10px;
  }
`;

const Card = styled.button.attrs({ type: 'button' })<{ $selected: boolean }>`
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: 2px;
  width: 100%;
  padding: 6px;
  border: none;
  border-radius: var(--radius);
  background: ${(p) => (p.$selected ? 'var(--soft)' : 'none')};
  box-shadow: ${(p) => (p.$selected ? 'inset 0 0 0 2px var(--highlight)' : 'none')};
  color: inherit;
  text-align: left;

  &:hover {
    background: ${(p) => (p.$selected ? 'var(--soft)' : 'var(--hover)')};
  }
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

export function LibraryGrid({ items, selection, onActivate, onLongPress }: CollectionProps) {
  const { library } = useLibrary();
  const { ratings } = userData(library);
  const longPress = useLongPress(onLongPress);
  const decor = useCollectionDecor();

  return (
    <Grid>
      {items.map((item) => {
        const selected = selection.has(item.id);
        return (
          <li key={item.id}>
            <Card
              $selected={selected}
              aria-pressed={selected}
              onClick={(e) => onActivate(item.id, clickModifiers(e))}
              {...longPress(item.id)}
            >
              <Cover item={item} />
              <CardTitle>{item.title}</CardTitle>
              <Creators>{item.creators.map((c) => c.name).join(', ')}</Creators>
              <Footer>
                <StarRating value={ratings[item.id]} />
                {decor.badge?.(item) ? <Badge>{decor.badge(item)}</Badge> : item.files.length === 0 && <Badge>no file</Badge>}
              </Footer>
            </Card>
          </li>
        );
      })}
    </Grid>
  );
}
