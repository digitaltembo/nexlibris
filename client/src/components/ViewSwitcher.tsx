import styled from 'styled-components';
import { VIEWS, type View } from '../views/views';

const Group = styled.div`
  display: inline-flex;
  padding: 1px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
`;

const Choice = styled.button.attrs({ type: 'button' })`
  display: inline-flex;
  align-items: center;
  padding: 3px 6px;
  border: none;
  border-radius: calc(var(--radius) - 2px);
  background: none;
  color: var(--muted);
  font-size: 0.85rem;
  cursor: pointer;

  &:hover {
    color: var(--text);
    background: var(--hover);
  }

  &[aria-pressed='true'] {
    color: var(--text);
    background: var(--soft);
  }
`;

/** Grid, list, or a plugin's view, as quiet icon buttons (the breadcrumbs' far right). */
export function ViewSwitcher({ view, onView }: { view: View; onView(view: View): void }) {
  return (
    <Group role="group" aria-label="View">
      {VIEWS.map((v) => (
        <Choice key={v.id} aria-pressed={view === v.id} aria-label={v.label} title={v.label} onClick={() => onView(v.id)}>
          {v.icon}
        </Choice>
      ))}
    </Group>
  );
}
