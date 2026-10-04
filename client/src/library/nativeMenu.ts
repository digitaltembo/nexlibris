import type { NativeMenu, NativeMenuItem } from '@nexlibris/common';
import { useEffect, useRef } from 'react';

/**
 * The desktop app's menu bar, from the page (`common/src/nativeMenu.ts`): menus whose items carry
 * what to run when chosen. The menus go to the app whenever they change; a chosen item's id comes
 * back and runs the latest version of it.
 */

export type MenuBarItem = Exclude<NativeMenuItem, { id: string } | { submenu: NativeMenuItem[] }> | MenuBarSubmenu | MenuBarCommand;

export interface MenuBarSubmenu {
  label: string;
  submenu: MenuBarItem[];
}

export type MenuBarCommand = Extract<NativeMenuItem, { id: string }> & { run(): void };

export interface MenuBar {
  label: string;
  items: MenuBarItem[];
}

/** Whether there's a menu bar to put the app's commands in: the desktop app's. */
export const hasMenuBar = () => typeof window !== 'undefined' && window.NexlibrisDesktop?.setMenu !== undefined;

/** The menus as sent to the app, and their commands by id. */
export function describeMenus(menus: MenuBar[]): { menus: NativeMenu[]; commands: Map<string, () => void> } {
  const commands = new Map<string, () => void>();
  const describe = (items: MenuBarItem[]): NativeMenuItem[] =>
    items.map((item) => {
      if ('submenu' in item) return { label: item.label, submenu: describe(item.submenu) };
      if (!('id' in item)) return item;
      const { run, ...rest } = item;
      commands.set(item.id, run);
      return rest;
    });
  return { menus: menus.map((menu) => ({ label: menu.label, items: describe(menu.items) })), commands };
}

/** Keeps the desktop app's menu bar showing `menus`; does nothing elsewhere. */
export function useMenuBar(menus: MenuBar[]) {
  const commands = useRef(new Map<string, () => void>());
  const sent = useRef('');
  const native = typeof window === 'undefined' ? undefined : window.NexlibrisDesktop;

  const described = describeMenus(menus);
  commands.current = described.commands;
  const text = JSON.stringify(described.menus);

  useEffect(() => {
    if (!native?.setMenu || text === sent.current) return;
    sent.current = text;
    native.setMenu(JSON.parse(text) as NativeMenu[]);
  }, [native, text]);

  useEffect(() => {
    if (!native?.onMenuCommand) return;
    native.onMenuCommand((id) => commands.current.get(id)?.());
    return () => {
      native.onMenuCommand?.(undefined);
      // The menus are the page's: put back the app's own when it stops showing them.
      sent.current = '';
      native.setMenu?.([]);
    };
  }, [native]);
}
