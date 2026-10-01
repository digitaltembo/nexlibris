import type { RpcSend } from '@nexlibris/common';
import { androidTransport, inAndroidApp } from './androidBridge';
import { desktopSend, inDesktopApp } from './desktopBridge';

/**
 * The transport to the native app this page runs in (Android or desktop), for
 * the Storage and Save APIs; undefined in a plain browser.
 */
export function nativeTransport(): RpcSend | undefined {
  if (inAndroidApp()) return androidTransport();
  if (inDesktopApp()) return desktopSend();
  return undefined;
}
