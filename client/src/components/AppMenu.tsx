import { useEffect, useRef } from 'react';
import styled from 'styled-components';
import { t } from '../i18n';

export type MenuEntry = { label: string; onSelect(): void; disabled?: boolean } | 'separator';

const Drawer = styled.dialog`
  margin: 0;
  width: calc(min(280px, calc(100vw - 48px)) + var(--safe-left, 0px));
  height: 100%;
  max-height: 100%;
  /* Its rows run to the screen's edge; their text keeps clear of the notch (--safe-left in GlobalStyle). */
  padding: 0 0 var(--safe-bottom, 0px);
  border: none;
  border-right: 1px solid var(--border);
  background: var(--surface);
  color: var(--text);
  box-shadow: 4px 0 24px rgb(0 0 0 / 0.2);

  &::backdrop {
    background: rgb(0 0 0 / 0.35);
  }

  h2 {
    margin: 0;
    padding: 14px 20px 14px calc(20px + var(--safe-left, 0px));
    font-size: 1.15rem;
    letter-spacing: 0.02em;
  }

  ul {
    margin: 0;
    padding: 4px 0 16px;
    list-style: none;
  }

  hr {
    margin: 6px 0;
    border: none;
    border-top: 1px solid var(--border);
  }
`;

const Entry = styled.button.attrs({ type: 'button' })`
  display: block;
  width: 100%;
  padding: 10px 20px 10px calc(20px + var(--safe-left, 0px));
  border: none;
  background: none;
  color: var(--text);
  font: inherit;
  text-align: left;
  cursor: pointer;

  &:hover:not(:disabled),
  &:focus-visible {
    background: var(--hover);
  }

  &:disabled {
    opacity: 0.4;
    cursor: default;
  }
`;

/** The button that opens the menu. */
export const MenuButton = styled.button.attrs({ type: 'button', 'aria-label': 'Menu', title: 'Menu' })`
  display: inline-flex;
  align-items: center;
  padding: 6px;
  border: none;
  border-radius: var(--radius);
  background: none;
  color: var(--text);
  cursor: pointer;

  &:hover {
    background: var(--hover);
  }
`;

interface Props {
  entries: MenuEntry[];
  onClose(): void;
}

/** The app's menu, in a drawer from the left (browsers and Android; the desktop app has a menu bar). */
export function AppMenu({ entries, onClose }: Props) {
  const ref = useRef<HTMLDialogElement>(null);

  // As in Modal: no close() on cleanup, since StrictMode's re-run would call onClose.
  useEffect(() => {
    if (!ref.current?.open) ref.current?.showModal();
  }, []);

  return (
    <Drawer
      ref={ref}
      aria-label={t('appMenu.label')}
      onClose={onClose}
      // A click on the dialog element itself (not its contents) is a click on the backdrop.
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <h2>{t('app.name')}</h2>
      <ul>
        {entries.map((entry, i) =>
          entry === 'separator' ? (
            <li key={i} role="separator">
              <hr />
            </li>
          ) : (
            <li key={i}>
              <Entry
                disabled={entry.disabled}
                onClick={() => {
                  onClose();
                  entry.onSelect();
                }}
              >
                {entry.label}
              </Entry>
            </li>
          ),
        )}
      </ul>
    </Drawer>
  );
}
