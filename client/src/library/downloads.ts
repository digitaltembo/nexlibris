import { inDesktopApp } from '../backends/desktopBridge';
import { inAndroidApp } from '../backends/androidBridge';
import { inIosApp } from '../backends/iosBridge';

/** Where nexlibris's source is, and where its releases are published until there's somewhere better. */
export const SOURCE_URL = 'https://github.com/digitaltembo/nexlibris';
const RELEASES_URL = `${SOURCE_URL}/releases/latest`;

/**
 * Where the About screen sends people for each app. A build can point them elsewhere with
 * `VITE_DOWNLOAD_DESKTOP`, `VITE_DOWNLOAD_ANDROID` and `VITE_DOWNLOAD_IOS` (a TestFlight link, say);
 * empty means there's nothing to download yet, as for iOS by default.
 */
export interface Downloads {
  /** The desktop app (Tauri), for macOS, Windows and Linux: the release, which has each. */
  desktop?: string;
  /** The Android app's APK. */
  android?: string;
  /** The iOS app, once there's a TestFlight or App Store link. */
  ios?: string;
}

const configured = (value: unknown, fallback?: string) => (typeof value === 'string' ? value.trim() || undefined : fallback);

export const DOWNLOADS: Downloads = {
  desktop: configured(import.meta.env.VITE_DOWNLOAD_DESKTOP, RELEASES_URL),
  android: configured(import.meta.env.VITE_DOWNLOAD_ANDROID, `${RELEASES_URL}/download/nexlibris.apk`),
  ios: configured(import.meta.env.VITE_DOWNLOAD_IOS),
};

/** Which app this is running in, if any: its download is left out of the list. */
export function currentApp(): keyof Downloads | undefined {
  if (inDesktopApp()) return 'desktop';
  if (inAndroidApp()) return 'android';
  if (inIosApp()) return 'ios';
  return undefined;
}
