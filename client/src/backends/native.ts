import type { RpcSend } from '@nexlibris/common';
import { desktopSend, inDesktopApp } from './desktopBridge';
import { inMobileApp, mobileTransport } from './mobileBridge';

/**
 * The transport to the native app this page runs in (Android, iOS or desktop), for
 * the Storage and Save APIs; undefined in a plain browser.
 */
export function nativeTransport(): RpcSend | undefined {
  if (inMobileApp()) return mobileTransport();
  if (inDesktopApp()) return desktopSend();
  return undefined;
}
