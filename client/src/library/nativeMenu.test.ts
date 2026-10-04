import type { NativeMenu } from '@nexlibris/common';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useMenuBar, type MenuBar } from './nativeMenu';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** Renders the hook with `menus`; returns a rerender and an unmount. */
function render(initial: MenuBar[]) {
  const Host = ({ menus }: { menus: MenuBar[] }) => {
    useMenuBar(menus);
    return null;
  };
  const root = createRoot(document.createElement('div'));
  act(() => root.render(createElement(Host, { menus: initial })));
  return {
    rerender: (menus: MenuBar[]) => act(() => root.render(createElement(Host, { menus }))),
    unmount: () => act(() => root.unmount()),
  };
}

describe('useMenuBar', () => {
  afterEach(() => {
    delete window.NexlibrisDesktop;
  });

  it('sends the menus without their commands, and runs the latest command for a chosen id', () => {
    const sent: NativeMenu[][] = [];
    let choose: ((id: string) => void) | undefined;
    window.NexlibrisDesktop = {
      rpc: vi.fn(),
      setMenu: (menus) => sent.push(menus),
      onMenuCommand: (handler) => {
        choose = handler;
      },
    };
    const first = vi.fn();
    const second = vi.fn();
    const menus = (run: () => void, checked: boolean): MenuBar[] => [
      {
        label: 'View',
        items: [
          { id: 'grid', label: 'as Grid', kind: 'radio', checked, run },
          { type: 'separator' },
          { role: 'zoomIn' },
          { label: 'Sort By', submenu: [{ id: 'title', label: 'Title', run }] },
        ],
      },
    ];

    const { rerender, unmount } = render(menus(first, true));
    expect(sent).toEqual([
      [
        {
          label: 'View',
          items: [
            { id: 'grid', label: 'as Grid', kind: 'radio', checked: true },
            { type: 'separator' },
            { role: 'zoomIn' },
            { label: 'Sort By', submenu: [{ id: 'title', label: 'Title' }] },
          ],
        },
      ],
    ]);

    // New handlers alone don't resend the menus, but they're what runs.
    rerender(menus(second, true));
    expect(sent).toHaveLength(1);
    choose!('title');
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledOnce();

    rerender(menus(second, false));
    expect(sent).toHaveLength(2);

    unmount();
    expect(sent.at(-1)).toEqual([]);
    expect(choose).toBeUndefined();
  });
});
