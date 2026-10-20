import { createMessageClient, hexColor, windowApiMeta, type WindowColors } from '@nexlibris/common';
import { inMobileApp, mobileTransport } from '../backends/mobileBridge';
import { isDark, onAppearanceChange } from './appearance';

/**
 * The colours around the page in the Android and iOS apps, behind the system bars (`common/src/windowApi.ts`):
 * the theme's background, or the reader's while it has colours of its own (epubier's themes).
 * Elsewhere this does nothing; the desktop app's title bar strip is part of the page.
 */

let reader: WindowColors | undefined;
let sent: string | undefined;

function themeColors(): WindowColors | undefined {
  const background = hexColor(getComputedStyle(document.documentElement).getPropertyValue('--bg'));
  return background === undefined ? undefined : { background, dark: isDark() };
}

function send() {
  if (!inMobileApp()) return;
  const colors = reader ?? themeColors();
  const key = colors && JSON.stringify(colors);
  if (!colors || key === sent) return;
  sent = key;
  createMessageClient(windowApiMeta, mobileTransport())
    .window.setColors(colors)
    .catch(() => {
      sent = undefined;
    });
}

/** Keeps the colours with the theme's from now on (once `GlobalStyle` is on the page). Returns the way to stop. */
export function followWindowColors(): () => void {
  send();
  return onAppearanceChange(send);
}

/** The reader's colours, while it has its own; undefined goes back to the theme's. */
export function setReaderColors(colors: WindowColors | undefined): void {
  reader = colors;
  send();
}
