import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MenuButton } from './MenuButton';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const menu = () => document.querySelector('[role="menu"]');
const entries = () => [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')];
const key = (key: string) =>
  act(() => void document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true })));

describe('a menu button', () => {
  it('opens its actions, moves between them with the arrows, and runs the one chosen', () => {
    const download = vi.fn();
    const remove = vi.fn();
    act(() =>
      root.render(
        <MenuButton
          label="Actions"
          actions={[
            { label: 'Download', onSelect: download },
            { label: 'Convert', onSelect: vi.fn(), disabled: true },
            { label: 'Remove…', danger: true, onSelect: remove },
          ]}
        />,
      ),
    );
    const button = container.querySelector('button')!;
    expect(menu()).toBeNull();
    act(() => button.click());
    expect(button.getAttribute('aria-expanded')).toBe('true');
    expect(document.activeElement).toBe(entries()[0]);
    // The disabled one is skipped.
    key('ArrowDown');
    expect(document.activeElement).toBe(entries()[2]);
    act(() => (document.activeElement as HTMLButtonElement).click());
    expect(remove).toHaveBeenCalledOnce();
    expect(download).not.toHaveBeenCalled();
    expect(menu()).toBeNull();
    expect(document.activeElement).toBe(button);
  });

  it('closes on Escape and on a click elsewhere', () => {
    act(() => root.render(<MenuButton label="Actions" actions={[{ label: 'Download', onSelect: vi.fn() }]} />));
    const button = container.querySelector('button')!;
    act(() => button.click());
    key('Escape');
    expect(menu()).toBeNull();
    act(() => button.click());
    act(() => void document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })));
    expect(menu()).toBeNull();
  });
});
