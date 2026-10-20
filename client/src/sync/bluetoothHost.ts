import {
  bluetoothHostApiMeta,
  createMessageClient,
  createSyncHub,
  decodeMessage,
  encodeMessage,
  fromBase64,
  toBase64,
  type BluetoothEvent,
  type LibraryBackend,
  type SyncHub,
  type SyncMessageRequest,
} from '@nexlibris/common';
import { useEffect } from 'react';
import { inMobileApp, mobileTransport } from '../backends/mobileBridge';
import { instanceName } from './hub';
import { instanceScope } from './instances';

/**
 * The Android or iOS app as a sync hub over Bluetooth (see `common/src/bluetoothApi.ts`): the app carries
 * the bytes, and the page, where the library is, answers each request with `createSyncHub`. Runs
 * while the app is open; turning it on and pairing are in the sync dialog.
 */

export const bluetoothHost = () => createMessageClient(bluetoothHostApiMeta, mobileTransport()).bluetoothHost;

/** What the hosting loop uses of the app's API. */
interface BluetoothHostClient {
  next(request: { timeoutMs: number }): Promise<BluetoothEvent[]>;
  send(request: { device: string; data: string }): Promise<null>;
}

/** Waits for requests and answers them with `hub`, until `stopped`. */
export async function serveBluetooth(api: BluetoothHostClient, hub: SyncHub, stopped: () => boolean): Promise<void> {
  while (!stopped()) {
    let events;
    try {
      events = await api.next({ timeoutMs: 20_000 });
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      continue;
    }
    // In order: a device sends its next request only once this one is answered.
    for (const event of events) {
      if (event.kind !== 'message') continue;
      try {
        const { header, body } = decodeMessage<SyncMessageRequest>(fromBase64(event.data));
        const response = await hub.handle({ ...header, body });
        await api.send({ device: event.device, data: toBase64(encodeMessage({ status: response.status }, response.body)) });
      } catch {
        // The device went away, or sent something unreadable: it gives up on its own.
      }
    }
  }
}

let current: SyncHub | undefined;

/** The hub answering over Bluetooth, for pairing codes and the list of paired devices. */
export const bluetoothSyncHub = () => current;

/** In the phone apps, answers requests from devices connected over Bluetooth; `refresh` shows what a sync changed. */
export function useBluetoothHosting(backend: LibraryBackend, refresh: () => Promise<void>) {
  useEffect(() => {
    if (!inMobileApp()) return;
    const hub = createSyncHub(backend, { name: instanceName, onApplied: () => void refresh(), scope: instanceScope });
    current = hub;
    let stopped = false;
    void serveBluetooth(bluetoothHost(), hub, () => stopped);
    return () => {
      stopped = true;
      if (current === hub) current = undefined;
    };
  }, [backend, refresh]);
}
