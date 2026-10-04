import type { ReactNode } from 'react';
import styled from 'styled-components';
import { NARROW } from '../styles/GlobalStyle';
import { besidePanel } from '../styles/ui';

const Bar = styled.nav<{ $withPanel: boolean }>`
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 12px;
  padding: 6px 16px;
  border-bottom: 1px solid var(--border);
  ${besidePanel}

  /* One line: on a narrow screen the levels above shrink to make room for the current one. */
  ol {
    display: flex;
    align-items: center;
    flex: 1;
    min-width: 0;
    margin: 0;
    padding: 0;
    list-style: none;
  }

  li {
    display: inline-flex;
    align-items: center;
    min-width: 0;
    flex-shrink: 1;
  }

  li:last-child {
    flex-shrink: 0;
    max-width: 100%;
  }

  li + li::before {
    content: '›';
    padding: 0 6px;
    color: var(--muted);
  }
`;

const CrumbButton = styled.button.attrs({ type: 'button' })`
  padding: 2px 4px;
  border: none;
  border-radius: 4px;
  background: none;
  color: var(--muted);
  font: inherit;
  cursor: pointer;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;

  &:hover {
    color: var(--text);
    background: var(--hover);
  }
`;

const Current = styled.span`
  padding: 2px 4px;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
`;

const Aside = styled.span`
  display: inline-flex;
  align-items: center;
  gap: 8px;
  color: var(--muted);
  font-size: 0.9em;
`;

/** How many things are shown; left out on narrow screens, where the trail needs the room. */
export const CrumbCount = styled.span`
  ${NARROW} {
    display: none;
  }
`;

interface Props {
  crumbs: { label: string; onSelect(): void }[];
  /** At the right: what's shown, and actions for this place. */
  children?: ReactNode;
  /** Leaves room for the side panel, as the rest of the page does. */
  withPanel: boolean;
}

/** Where the library view is, from the Library down; every level but the last can be gone back to. */
export function Breadcrumbs({ crumbs, children, withPanel }: Props) {
  return (
    <Bar aria-label="Breadcrumbs" $withPanel={withPanel}>
      <ol>
        {crumbs.map((crumb, i) => (
          <li key={i}>
            {i === crumbs.length - 1 ? (
              <Current aria-current="page">{crumb.label}</Current>
            ) : (
              <CrumbButton onClick={crumb.onSelect}>{crumb.label}</CrumbButton>
            )}
          </li>
        ))}
      </ol>
      {children && <Aside>{children}</Aside>}
    </Bar>
  );
}

/** A quiet action at the breadcrumbs' end, such as "Edit categories…". */
export const CrumbAction = styled(CrumbButton)`
  font-size: inherit;
`;
