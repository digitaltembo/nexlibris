import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import styled, { css } from 'styled-components';
import { Button } from '../styles/ui';

export interface MenuAction {
  label: string;
  onSelect(): void;
  /** Destructive, shown in the danger colour. */
  danger?: boolean;
  disabled?: boolean;
}

/** A dropdown's panel, fixed to the viewport so a scrolling panel doesn't clip it. */
export const MenuPanel = styled.div`
  position: fixed;
  z-index: 10;
  display: flex;
  flex-direction: column;
  min-width: 160px;
  padding: 4px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--surface);
  box-shadow: 0 6px 20px rgb(0 0 0 / 0.25);
`;

/** An entry in a `MenuPanel`. */
export const MenuEntry = styled.button.attrs({ type: 'button' })<{ $danger?: boolean }>`
  padding: 6px 10px;
  border: 0;
  border-radius: 5px;
  background: none;
  font: inherit;
  font-size: 0.9em;
  text-align: left;
  white-space: nowrap;
  color: var(--text);
  cursor: pointer;
  ${(p) =>
    p.$danger &&
    css`
      color: var(--danger);
    `}

  &:hover:not(:disabled),
  &:focus-visible {
    background: var(--hover);
    outline: none;
  }

  &:disabled {
    opacity: 0.4;
    cursor: default;
  }
`;

/**
 * A "⋯" button opening a menu of actions. The menu is fixed to the viewport beside the button, so
 * a scrolling panel doesn't clip it, and closes on choosing, Escape, a click elsewhere or scrolling.
 */
export function MenuButton({ label, actions }: { label: string; actions: MenuAction[] }) {
  const [open, setOpen] = useState(false);
  const [place, setPlace] = useState<{ top: number; right: number }>();
  const button = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);

  const close = (refocus: boolean) => {
    setOpen(false);
    setPlace(undefined);
    if (refocus) button.current?.focus();
  };

  // Below the button, right-aligned with it; above it if there's no room below.
  useLayoutEffect(() => {
    if (!open || !button.current || !list.current) return;
    const anchor = button.current.getBoundingClientRect();
    const height = list.current.offsetHeight;
    const below = anchor.bottom + 4;
    const top = below + height > window.innerHeight && anchor.top - 4 - height > 0 ? anchor.top - 4 - height : below;
    setPlace({ top, right: Math.max(4, window.innerWidth - anchor.right) });
    list.current.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!list.current?.contains(target) && !button.current?.contains(target)) close(false);
    };
    const away = () => close(false);
    document.addEventListener('pointerdown', outside);
    window.addEventListener('scroll', away, true);
    window.addEventListener('resize', away);
    return () => {
      document.removeEventListener('pointerdown', outside);
      window.removeEventListener('scroll', away, true);
      window.removeEventListener('resize', away);
    };
  }, [open]);

  const onKeyDown = (event: KeyboardEvent) => {
    const entries = [...(list.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])];
    const at = entries.indexOf(document.activeElement as HTMLButtonElement);
    const focus = (i: number) => entries[(i + entries.length) % entries.length]?.focus();
    if (event.key === 'Escape') close(true);
    else if (event.key === 'Tab') close(false);
    else if (event.key === 'ArrowDown') focus(at + 1);
    else if (event.key === 'ArrowUp') focus(at - 1);
    else if (event.key === 'Home') focus(0);
    else if (event.key === 'End') focus(-1);
    else return;
    if (event.key !== 'Tab') event.preventDefault();
  };

  return (
    <>
      <Button
        ref={button}
        $variant="icon"
        aria-label={label}
        title={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => (open ? close(false) : setOpen(true))}
      >
        ⋯
      </Button>
      {open && (
        <MenuPanel
          ref={list}
          role="menu"
          aria-label={label}
          style={place ? { top: place.top, right: place.right } : { visibility: 'hidden' }}
          onKeyDown={onKeyDown}
        >
          {actions.map((action) => (
            <MenuEntry
              role="menuitem"
              key={action.label}
              $danger={action.danger}
              disabled={action.disabled}
              onClick={() => {
                close(true);
                action.onSelect();
              }}
            >
              {action.label}
            </MenuEntry>
          ))}
        </MenuPanel>
      )}
    </>
  );
}
