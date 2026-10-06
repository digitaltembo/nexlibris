import { afterEach, describe, expect, it } from 'vitest';
import { APPEARANCE_KEY, applyAppearance, isDark, onAppearanceChange, storedAppearance } from './appearance';

afterEach(() => {
  localStorage.clear();
  applyAppearance('system');
  document.head.querySelectorAll('meta[name="theme-color"]').forEach((m) => m.remove());
  document.documentElement.style.removeProperty('--bg');
});

describe('appearance', () => {
  it('reads the stored pick, as usePersistentState stores it, and the system otherwise', () => {
    expect(storedAppearance()).toBe('system');
    localStorage.setItem(APPEARANCE_KEY, JSON.stringify('dark'));
    expect(storedAppearance()).toBe('dark');
    localStorage.setItem(APPEARANCE_KEY, 'not json');
    expect(storedAppearance()).toBe('system');
    localStorage.setItem(APPEARANCE_KEY, JSON.stringify('sepia'));
    expect(storedAppearance()).toBe('system');
  });

  it('marks the page with a pick, and leaves the system to decide otherwise', () => {
    const root = document.documentElement;
    applyAppearance('dark');
    expect(root.dataset.theme).toBe('dark');
    expect(isDark()).toBe(true);
    applyAppearance('light');
    expect(isDark()).toBe(false);
    applyAppearance('system');
    expect(root.dataset.theme).toBeUndefined();
    expect(isDark()).toBe(matchMedia('(prefers-color-scheme: dark)').matches);
  });

  it('colours the browser chrome as picked, and gives it back to the system', () => {
    document.head.insertAdjacentHTML(
      'beforeend',
      '<meta name="theme-color" content="#fdf8e5" media="(prefers-color-scheme: light)"><meta name="theme-color" content="#071f37" media="(prefers-color-scheme: dark)">',
    );
    const colours = () => [...document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')].map((m) => m.content);
    document.documentElement.style.setProperty('--bg', '#071f37');
    applyAppearance('dark');
    expect(colours()).toEqual(['#071f37', '#071f37']);
    applyAppearance('system');
    expect(colours()).toEqual(['#fdf8e5', '#071f37']);
  });

  it('says when a pick changes', async () => {
    let changes = 0;
    const stop = onAppearanceChange(() => changes++);
    applyAppearance('dark');
    await Promise.resolve();
    expect(changes).toBe(1);
    stop();
    applyAppearance('light');
    await Promise.resolve();
    expect(changes).toBe(1);
  });
});
