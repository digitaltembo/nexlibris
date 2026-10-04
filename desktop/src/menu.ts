import { NATIVE_MENU_ROLES, type NativeMenu, type NativeMenuItem, type NativeMenuRole } from '@nexlibris/common';
import type { MenuItemConstructorOptions } from 'electron';

/**
 * The menu bar, from the menus the page describes (`common/src/nativeMenu.ts`). The main process
 * adds what belongs to it: on macOS the app menu (with any items the page marks `appMenu`, such as
 * Settings…), Quit elsewhere, and the Window menu.
 */

interface Options {
  platform: NodeJS.Platform;
  appName: string;
  /** Called with an item's `id` when it's chosen. */
  send(id: string): void;
}

const MAX_ITEMS = 200;
const roles = new Set<string>(NATIVE_MENU_ROLES);
const isText = (value: unknown, max: number): value is string => typeof value === 'string' && value.length > 0 && value.length <= max;

/** The page's menus, checked: anything malformed is dropped rather than shown. */
export function parseMenus(value: unknown): NativeMenu[] {
  let budget = MAX_ITEMS;
  const parseItems = (items: unknown, depth: number): NativeMenuItem[] => {
    if (!Array.isArray(items) || depth > 3) return [];
    const parsed: NativeMenuItem[] = [];
    for (const item of items as Record<string, unknown>[]) {
      if (--budget < 0 || typeof item !== 'object' || item === null) break;
      if (item.type === 'separator') parsed.push({ type: 'separator' });
      else if (typeof item.role === 'string' && roles.has(item.role)) parsed.push({ role: item.role as NativeMenuRole });
      else if (isText(item.label, 100) && Array.isArray(item.submenu)) {
        parsed.push({ label: item.label, submenu: parseItems(item.submenu, depth + 1) });
      } else if (isText(item.label, 100) && isText(item.id, 100)) {
        parsed.push({
          id: item.id,
          label: item.label,
          ...(isText(item.accelerator, 40) && /^[\w+,.=\-/]+$/.test(item.accelerator) && { accelerator: item.accelerator }),
          ...(typeof item.enabled === 'boolean' && { enabled: item.enabled }),
          ...((item.kind === 'radio' || item.kind === 'checkbox') && { kind: item.kind, checked: item.checked === true }),
          ...(item.appMenu === true && { appMenu: true }),
        });
      }
    }
    return parsed;
  };
  if (!Array.isArray(value)) return [];
  return (value as Record<string, unknown>[])
    .filter((menu) => typeof menu === 'object' && menu !== null && isText(menu.label, 40))
    .slice(0, 10)
    .map((menu) => ({ label: menu.label as string, items: parseItems(menu.items, 0) }));
}

/** The menu bar's template: the page's menus and the app's own. */
export function menuTemplate(menus: NativeMenu[], { platform, appName, send }: Options): MenuItemConstructorOptions[] {
  const mac = platform === 'darwin';
  const lifted: MenuItemConstructorOptions[] = [];

  const convert = (items: NativeMenuItem[]): MenuItemConstructorOptions[] => {
    const converted: MenuItemConstructorOptions[] = [];
    for (const item of items) {
      if ('type' in item) converted.push({ type: 'separator' });
      else if ('role' in item) converted.push({ role: item.role });
      else if ('submenu' in item) converted.push({ label: item.label, submenu: convert(item.submenu) });
      else {
        const option: MenuItemConstructorOptions = {
          label: item.label,
          click: () => send(item.id),
          ...(item.accelerator && { accelerator: item.accelerator }),
          ...(item.enabled === false && { enabled: false }),
          ...(item.kind && { type: item.kind, checked: item.checked ?? false }),
        };
        if (mac && item.appMenu) lifted.push(option);
        else converted.push(option);
      }
    }
    // Separators left at an end or doubled by lifting items out.
    return converted.filter(
      (option, i) =>
        option.type !== 'separator' || (i > 0 && i < converted.length - 1 && converted[i - 1]!.type !== 'separator'),
    );
  };

  const template: MenuItemConstructorOptions[] = menus.map((menu) => ({ label: menu.label, submenu: convert(menu.items) }));
  if (mac) {
    template.unshift({
      label: appName,
      submenu: [
        { role: 'about' },
        ...(lifted.length ? [{ type: 'separator' } as const, ...lifted] : []),
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    });
  } else {
    const first = template[0]?.submenu as MenuItemConstructorOptions[] | undefined;
    if (first) first.push({ type: 'separator' }, { role: 'quit' });
    else template.push({ label: 'File', submenu: [{ role: 'quit' }] });
  }
  template.push({ role: 'windowMenu' });
  return template;
}
