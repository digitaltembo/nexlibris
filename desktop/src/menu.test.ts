import type { NativeMenu } from '@nexlibris/common';
import type { MenuItemConstructorOptions } from 'electron';
import { describe, expect, it, vi } from 'vitest';
import { menuTemplate, parseMenus } from './menu';

const menus: NativeMenu[] = [
  {
    label: 'File',
    items: [
      { id: 'import', label: 'Import Files…', accelerator: 'CmdOrCtrl+O' },
      { type: 'separator' },
      { id: 'settings', label: 'Settings…', accelerator: 'CmdOrCtrl+,', appMenu: true },
    ],
  },
  {
    label: 'View',
    items: [
      { id: 'view:grid', label: 'as Grid', kind: 'radio', checked: true },
      { id: 'view:list', label: 'as List', kind: 'radio', checked: false },
      { type: 'separator' },
      { label: 'Sort By', submenu: [{ id: 'sort:title', label: 'Title', kind: 'radio', checked: true }] },
      { role: 'togglefullscreen' },
    ],
  },
];

const submenu = (option: MenuItemConstructorOptions | undefined) => option?.submenu as MenuItemConstructorOptions[];
const labels = (options: MenuItemConstructorOptions[]) => options.map((o) => o.label ?? o.role ?? o.type);

describe('menuTemplate', () => {
  it('puts app-menu items in the macOS app menu, and sends ids on click', () => {
    const send = vi.fn();
    const template = menuTemplate(menus, { platform: 'darwin', appName: 'nexlibris', send });
    expect(labels(template)).toEqual(['nexlibris', 'File', 'View', 'windowMenu']);
    const app = submenu(template[0]);
    expect(labels(app)).toEqual(['about', 'separator', 'Settings…', 'separator', 'services', 'separator', 'hide', 'hideOthers', 'unhide', 'separator', 'quit']);
    // File lost Settings…, and the separator before it with it.
    expect(labels(submenu(template[1]))).toEqual(['Import Files…']);
    app[2]!.click!(undefined as never, undefined, undefined as never);
    expect(send).toHaveBeenCalledWith('settings');

    const view = submenu(template[2]);
    expect(view[0]).toMatchObject({ label: 'as Grid', type: 'radio', checked: true });
    expect(submenu(view[3])[0]).toMatchObject({ label: 'Title', type: 'radio', checked: true });
    expect(view[4]).toEqual({ role: 'togglefullscreen' });
  });

  it('puts the page’s About first in the macOS app menu, in place of the system’s', () => {
    const withAbout: NativeMenu[] = [
      { label: 'Help', items: [{ id: 'about', label: 'About nexlibris', appMenu: true }] },
      ...menus,
    ];
    const template = menuTemplate(withAbout, { platform: 'darwin', appName: 'nexlibris', send: () => undefined });
    expect(labels(submenu(template[0])).slice(0, 4)).toEqual(['About nexlibris', 'separator', 'Settings…', 'separator']);
  });

  it('keeps app-menu items in place elsewhere, with Quit in the first menu', () => {
    const template = menuTemplate(menus, { platform: 'win32', appName: 'nexlibris', send: () => undefined });
    expect(labels(template)).toEqual(['File', 'View', 'windowMenu']);
    expect(labels(submenu(template[0]))).toEqual(['Import Files…', 'separator', 'Settings…', 'separator', 'quit']);
  });
});

describe('parseMenus', () => {
  it('keeps well-formed menus as they are', () => {
    expect(parseMenus(JSON.parse(JSON.stringify(menus)))).toEqual(menus);
  });

  it('drops what it doesn’t know', () => {
    const parsed = parseMenus([
      { label: 'File', items: [{ role: 'quit' }, { id: 'x', label: 'X', accelerator: 'Cmd+O; rm' }, { label: 'No id' }, 'junk'] },
      { items: [] },
      'junk',
    ]);
    expect(parsed).toEqual([{ label: 'File', items: [{ id: 'x', label: 'X' }] }]);
    expect(parseMenus(undefined)).toEqual([]);
  });
});
