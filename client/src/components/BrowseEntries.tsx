import styled from 'styled-components';
import type { BrowseEntry, BrowsePath } from '../library/browse';
import { NARROW } from '../styles/GlobalStyle';
import { Cover } from './Cover';

const Grid = styled.ul`
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
  gap: 16px;
  margin: 0;
  padding: 0;
  list-style: none;

  ${NARROW} {
    grid-template-columns: repeat(auto-fill, minmax(110px, 1fr));
    gap: 10px;
  }
`;

const Card = styled.button.attrs({ type: 'button' })`
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: 2px;
  width: 100%;
  padding: 6px;
  border: none;
  border-radius: var(--radius);
  background: none;
  color: inherit;
  text-align: left;
  cursor: pointer;

  &:hover {
    background: var(--hover);
  }
`;

/** A cover with the edges of others behind it: a group of books rather than one. */
const Stack = styled.span`
  position: relative;
  display: block;
  margin: 6px 6px 0 0;

  &::before,
  &::after {
    content: '';
    position: absolute;
    inset: 0;
    border: 1px solid var(--border);
    border-radius: 4px;
    background: var(--surface);
  }

  &::before {
    transform: translate(6px, -6px);
  }

  &::after {
    transform: translate(3px, -3px);
  }

  > * {
    position: relative;
    z-index: 1;
  }
`;

const Label = styled.span`
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  margin-top: 6px;
  font-weight: 600;
`;

const Detail = styled.span`
  color: var(--muted);
  font-size: 0.9em;
`;

const Rows = styled.ul`
  margin: 0;
  padding: 0;
  list-style: none;
`;

const Row = styled.button.attrs({ type: 'button' })`
  display: flex;
  align-items: baseline;
  gap: 12px;
  width: 100%;
  padding: 8px;
  border: none;
  border-bottom: 1px solid var(--border);
  background: none;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;

  &:hover {
    background: var(--hover);
  }

  > span:first-child {
    flex: 1;
    font-weight: 500;
  }

  &::after {
    content: '›';
    color: var(--muted);
  }
`;

interface Props {
  entries: BrowseEntry[];
  layout: 'grid' | 'list';
  onOpen(path: BrowsePath): void;
}

/** A browse level's entries (categories, authors, series, tags), as stacked covers or as rows. */
export function BrowseEntries({ entries, layout, onOpen }: Props) {
  if (layout === 'list') {
    return (
      <Rows>
        {entries.map((entry) => (
          <li key={entry.path.join('/')}>
            <Row onClick={() => onOpen(entry.path)}>
              <span>{entry.label}</span>
              <Detail>{entry.detail}</Detail>
            </Row>
          </li>
        ))}
      </Rows>
    );
  }
  return (
    <Grid>
      {entries.map((entry) => (
        <li key={entry.path.join('/')}>
          <Card onClick={() => onOpen(entry.path)}>
            <Stack>
              <Cover item={entry.sample} {...(!entry.sample?.cover && { label: entry.label })} />
            </Stack>
            <Label>{entry.label}</Label>
            <Detail>{entry.detail}</Detail>
          </Card>
        </li>
      ))}
    </Grid>
  );
}
