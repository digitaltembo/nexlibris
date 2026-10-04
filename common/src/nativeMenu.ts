/**
 * The desktop app's menu bar, described by the page (desktop only): the page sends its menus
 * whenever they change (`NexlibrisDesktop.setMenu`), the main process builds the native menu from
 * them (`desktop/src/menu.ts`), and a click comes back to the page as the item's `id`
 * (`NexlibrisDesktop.onMenuCommand`). The page's own menu for browsers and Android is the same
 * list of commands, so the two stay in step.
 */

/** Electron's built-in menu items the page may use. */
export const NATIVE_MENU_ROLES = [
  'undo',
  'redo',
  'cut',
  'copy',
  'paste',
  'reload',
  'toggleDevTools',
  'resetZoom',
  'zoomIn',
  'zoomOut',
  'togglefullscreen',
] as const;

export type NativeMenuRole = (typeof NATIVE_MENU_ROLES)[number];

export type NativeMenuItem =
  | { type: 'separator' }
  | { role: NativeMenuRole }
  | { label: string; submenu: NativeMenuItem[] }
  | {
      /** Sent back to the page when the item is chosen. */
      id: string;
      label: string;
      /** In Electron's syntax, e.g. `CmdOrCtrl+O`. */
      accelerator?: string;
      enabled?: boolean;
      /** A radio item (one of its run of radio items) or a checkbox, with `checked`. */
      kind?: 'radio' | 'checkbox';
      checked?: boolean;
      /** On macOS, shown in the app menu instead (as Settings… is). */
      appMenu?: boolean;
    };

export interface NativeMenu {
  label: string;
  items: NativeMenuItem[];
}
