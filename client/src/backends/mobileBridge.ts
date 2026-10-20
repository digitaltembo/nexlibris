import type { RpcSend } from '@nexlibris/common';
import { androidTransport, inAndroidApp } from './androidBridge';
import { inIosApp, iosSend } from './iosBridge';

/**
 * The phone apps, Android's and iOS's, which serve the same native APIs over their bridges: storage
 * and the library's folder, saving and importing, relaying calls to sync hubs and readers on the
 * network, hosting sync over Bluetooth, the sync folder and the colours around the page.
 */

/** Whether this page is running inside the Android or iOS app. */
export const inMobileApp = () => inAndroidApp() || inIosApp();

/** Which phone app this page runs in, if any. */
export const mobileApp = (): 'android' | 'ios' | undefined => (inAndroidApp() ? 'android' : inIosApp() ? 'ios' : undefined);

let ios: RpcSend | undefined;

/** The page's transport to the phone app it runs in (see {@link inMobileApp}). */
export const mobileTransport = (): RpcSend => (inAndroidApp() ? androidTransport() : (ios ??= iosSend()));
