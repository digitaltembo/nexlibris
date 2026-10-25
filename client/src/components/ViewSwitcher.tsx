import styled from 'styled-components';
import { VIEWS, type View } from '../views/views';
import { EyeIcon } from './icons';
import { t } from '../i18n';

const Bar = styled.div`
  display: inline-flex;
  align-items: center;
  gap: 4px;
`;

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

/**
 * Grid, list, or a plugin's view, as quiet icon buttons (the breadcrumbs' far right), after an eye that opens the
 * view's settings (appearance, sort, columns) when `onSettings` is given.
 */
export function ViewSwitcher({ view, onView, onSettings }: { view: View; onView(view: View): void; onSettings?(): void }) {
  return (
    <Bar>
      {onSettings && (
        <Choice aria-label={t('viewSwitcher.settings')} title={t('viewSwitcher.settings')} onClick={onSettings}>
          <EyeIcon />
        </Choice>
      )}
      <Group role="group" aria-label={t('viewSwitcher.label')}>
        {VIEWS.map((v) => (
          <Choice key={v.id} aria-pressed={view === v.id} aria-label={v.label} title={v.label} onClick={() => onView(v.id)}>
            {v.icon}
          </Choice>
        ))}
      </Group>
    </Bar>
  );
}
