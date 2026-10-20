import { post, type SimpleMeta } from 'estuary-rpc';

/**
 * The colours around the page in the Android app: the strips behind the status and navigation
 * bars, which the WebView doesn't cover, and whether the bars' icons should be light. The page
 * sets them to its own background, or to the reader's while a book is open
 * (`client/src/styles/windowColors.ts`). Android only.
 */
export interface WindowColors {
  /** `#rrggbb`. */
  background: string;
  /** Whether the background is dark, so the bars' icons are drawn light. */
  dark: boolean;
}

export const windowApiMeta = {
  window: {
    setColors: post<WindowColors, null, SimpleMeta>('api/window/setColors'),
  },
};

export type WindowApi = typeof windowApiMeta;

/** A CSS colour as computed (`rgb(…)`, `rgba(…)`) or written (`#rgb`, `#rrggbb`) as `#rrggbb`; undefined otherwise. */
export function hexColor(color: string): string | undefined {
  const text = color.trim().toLowerCase();
  const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/.exec(text);
  if (short) return `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}`;
  if (/^#[0-9a-f]{6}$/.test(text)) return text;
  const rgb = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/.exec(text);
  if (!rgb) return undefined;
  return `#${rgb
    .slice(1, 4)
    .map((c) => Math.min(255, Math.round(Number(c))).toString(16).padStart(2, '0'))
    .join('')}`;
}
