import { get, post, type SimpleMeta } from 'estuary-rpc';

/**
 * Sync over Bluetooth (M6): the Android or iOS app is the hub, as a Bluetooth LE peripheral that a
 * browser or the desktop app connects to with Web Bluetooth (which can only connect, not be
 * connected to). Its GATT service has two characteristics: the client writes request chunks to
 * `BLUETOOTH_REQUESTS`, and the hub answers with notifications on `BLUETOOTH_RESPONSES`, framed as
 * in `syncMessage.ts`.
 *
 * The app only carries the bytes: its page answers each request with `createSyncHub`. This API is
 * how the page runs that, in the Android and iOS apps only.
 */

export const BLUETOOTH_SERVICE = '4e28ef00-8886-467b-9c6a-a0b49a90cf89';
export const BLUETOOTH_REQUESTS = '75b3ab92-7677-4775-96eb-6df34e2ea9fe';
export const BLUETOOTH_RESPONSES = '9a47303a-9028-4737-af10-810a6f50a363';
/** The most a client writes at once: GATT's limit for one value. */
export const BLUETOOTH_WRITE_SIZE = 512;

export interface BluetoothHostStatus {
  /** Left on: hosting resumes when the app opens. */
  enabled: boolean;
  /** Advertising and accepting connections right now. */
  running: boolean;
  /** Devices connected now. */
  connected: number;
  /** What nearby devices see it as (the phone's Bluetooth name). */
  name?: string;
  /** Why it isn't running, when it should be. */
  error?: string;
}

/** Something that happened on the link, for the page to act on. */
export type BluetoothEvent =
  | { kind: 'connected' | 'disconnected'; device: string }
  /** A whole request from `device`, base64. */
  | { kind: 'message'; device: string; data: string };

export const bluetoothHostApiMeta = {
  bluetoothHost: {
    status: get<null, BluetoothHostStatus, SimpleMeta>('api/bluetoothHost/status'),
    /** Turns hosting on (asking for Bluetooth permission, and to turn Bluetooth on, if need be) or off. */
    setEnabled: post<{ enabled: boolean }, BluetoothHostStatus, SimpleMeta>('api/bluetoothHost/setEnabled'),
    /** Waits up to `timeoutMs` for events, and returns those there are (possibly none). */
    next: post<{ timeoutMs: number }, BluetoothEvent[], SimpleMeta>('api/bluetoothHost/next'),
    /** Sends a whole response (base64) to `device`, chunked to fit its link; resolves once it's all sent. */
    send: post<{ device: string; data: string }, null, SimpleMeta>('api/bluetoothHost/send'),
  },
};

export type BluetoothHostApi = typeof bluetoothHostApiMeta;
