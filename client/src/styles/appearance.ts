import { t } from '../i18n';
/**
 * Light or dark: the system's choice unless one is picked in Settings. A pick is kept per device
 * (in localStorage, as the view is) and marks the page `<html data-theme="light|dark">`, which
 * `GlobalStyle` follows ahead of the system's `prefers-color-scheme`.
 */

export type Appearance = 'system' | 'light' | 'dark';

export const APPEARANCES: { id: Appearance; label: string }[] = [
  { id: 'system', label: t('appearance.system') },
  { id: 'light', label: t('appearance.light') },
  { id: 'dark', label: t('appearance.dark') },
];

/** Where the pick is kept; `usePersistentState` stores it as JSON under this key. */
export const APPEARANCE_KEY = 'nexlibris:appearance';

const SYSTEM_DARK = '(prefers-color-scheme: dark)';

/** The stored pick, read before the page first renders so a picked theme doesn't flash the other. */
export function storedAppearance(): Appearance {
  try {
    const stored = JSON.parse(localStorage.getItem(APPEARANCE_KEY) ?? '"system"') as unknown;
    return APPEARANCES.some((a) => a.id === stored) ? (stored as Appearance) : 'system';
  } catch {
    return 'system';
  }
}

/** Marks the page with the pick, and gives the browser's own chrome (`theme-color`) the colour it shows. */
export function applyAppearance(appearance: Appearance, root: HTMLElement = document.documentElement): void {
  if (appearance === 'system') delete root.dataset.theme;
  else root.dataset.theme = appearance;
  const metas = document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]');
  if (!metas.length) return;
  const background = getComputedStyle(root).getPropertyValue('--bg').trim();
  for (const meta of metas) {
    // Each keeps the colour of the scheme its media query names; a pick overrides both.
    meta.dataset.scheme ??= meta.content;
    meta.content = appearance === 'system' || !background ? meta.dataset.scheme : background;
  }
}

/** Whether the page is dark now: picked so, or following a dark system. */
export function isDark(root: HTMLElement = document.documentElement): boolean {
  const picked = root.dataset.theme;
  return picked ? picked === 'dark' : matchMedia(SYSTEM_DARK).matches;
}

/** Calls `onChange` when the page turns light or dark, by a pick or the system's change. Returns the way to stop. */
export function onAppearanceChange(onChange: () => void, root: HTMLElement = document.documentElement): () => void {
  const system = matchMedia(SYSTEM_DARK);
  const picks = new MutationObserver(onChange);
  picks.observe(root, { attributes: true, attributeFilter: ['data-theme'] });
  system.addEventListener('change', onChange);
  return () => {
    picks.disconnect();
    system.removeEventListener('change', onChange);
  };
}
