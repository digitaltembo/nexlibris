import {
  chunkMessage,
  createItem,
  createSyncHub,
  MemoryStorage,
  MessageAssembler,
  pairWithHub,
  previewSync,
  runSync,
  stateDigest,
  StoredLibraryBackend,
  toBase64,
  fromBase64,
  transferFiles,
  httpSyncClient,
  type BluetoothEvent,
} from '@nexlibris/common';
import { describe, expect, it } from 'vitest';
import { BLUETOOTH_BASE, connect, linkFetch, rememberLink, type BluetoothDeviceLike, type GattCharacteristic } from './bluetooth';
import { serveBluetooth } from './bluetoothHost';
import { connectHub } from './connect';

/**
 * A phone hosting sync, as the browser reaches it over Bluetooth: the app's side (put requests
 * back together, notify responses in chunks that fit a small link) stood in for in memory, with
 * the real hosting loop and hub behind it.
 */
function fakePhone(phone: StoredLibraryBackend, notifySize = 20) {
  const hub = createSyncHub(phone, { name: () => 'Pixel' });
  const events: BluetoothEvent[] = [];
  let wake: (() => void) | undefined;
  let stopped = false;
  const assembler = new MessageAssembler();
  let connected = false;
  const responses = Object.assign(new EventTarget(), {
    value: undefined as DataView | undefined,
    startNotifications: async () => responses as unknown as GattCharacteristic,
    writeValueWithResponse: async () => undefined,
  });
  const requests = Object.assign(new EventTarget(), {
    startNotifications: async () => requests as unknown as GattCharacteristic,
    async writeValueWithResponse(value: BufferSource) {
      if (!connected) throw new Error('GATT Server is disconnected.');
      const message = assembler.push(new Uint8Array(value as ArrayBuffer));
      if (message) {
        events.push({ kind: 'message', device: 'AA:BB', data: toBase64(message) });
        wake?.();
      }
    },
  });
  const device: BluetoothDeviceLike = Object.assign(new EventTarget(), {
    id: 'device-1',
    name: 'Pixel',
    gatt: {
      get connected() {
        return connected;
      },
      async connect() {
        connected = true;
        return device.gatt!;
      },
      disconnect() {
        connected = false;
        assembler.reset();
        device.dispatchEvent(new Event('gattserverdisconnected'));
      },
      getPrimaryService: async () => ({
        getCharacteristic: async (uuid: string) =>
          (uuid.startsWith('75b3') ? requests : responses) as unknown as GattCharacteristic,
      }),
    },
  });
  let writes = 0;
  const native = {
    next: async () => {
      if (!events.length) await new Promise<void>((resolve) => (wake = resolve));
      return events.splice(0);
    },
    async send({ data }: { device: string; data: string }) {
      for (const chunk of chunkMessage(fromBase64(data), notifySize)) {
        writes++;
        responses.value = new DataView(chunk.buffer);
        responses.dispatchEvent(new Event('characteristicvaluechanged'));
        await Promise.resolve();
      }
      return null;
    },
  };
  void serveBluetooth(native, hub, () => stopped);
  return { hub, device, notifications: () => writes, stop: () => ((stopped = true), wake?.()) };
}

describe('sync over Bluetooth', () => {
  it('pairs, syncs and moves files over a link that carries 20 bytes at a time', async () => {
    const phone = new StoredLibraryBackend(new MemoryStorage(), 'Phone');
    const browser = new StoredLibraryBackend(new MemoryStorage(), 'Browser');
    const big = 'a book on the phone '.repeat(200);
    const { hash, size } = await phone.putFile(new Blob([big]));
    await phone.apply([{ type: 'addItem', item: createItem({ title: 'Phone book', files: [{ hash, size, format: 'epub' }] }) }]);
    const mine = await browser.putFile(new Blob(['a book in the browser '.repeat(100)]));
    await browser.apply([{ type: 'addItem', item: createItem({ title: 'Browser book', files: [{ ...mine, format: 'epub' }] }) }]);

    const fake = fakePhone(phone);
    const link = await connect(fake.device);
    const { code } = fake.hub.newCode();
    const client = httpSyncClient(BLUETOOTH_BASE, undefined, linkFetch(link));
    const pairing = await pairWithHub(browser, client, 'bluetooth:Pixel', code, 'Chrome');
    rememberLink(pairing.hub.origin, link);

    // As the sync dialog does it, reaching the hub from the pairing.
    const hub = await connectHub(pairing, browser, false);
    await runSync(browser, hub.client, pairing, await previewSync(browser, hub.client, pairing));
    expect(stateDigest(await browser.getLibrary()).hash).toBe(stateDigest(await phone.getLibrary()).hash);
    expect(await transferFiles(browser, hub.files)).toMatchObject({ uploaded: 1, downloaded: 1, failed: [] });
    expect(await (await browser.getFile(hash))!.text()).toBe(big);
    expect(await phone.hasFile(mine.hash)).toBe(true);
    expect(fake.notifications()).toBeGreaterThan(200);

    // Dropped: the link reconnects to the same phone without asking which.
    fake.device.gatt!.disconnect();
    const again = await connectHub(pairing, browser, false);
    expect((await again.client.hello(null)).name).toBe('Pixel');
    fake.stop();
  });

  it('fails a call cleanly when the link drops mid-way', async () => {
    const fake = fakePhone(new StoredLibraryBackend(new MemoryStorage()));
    const link = await connect(fake.device);
    const client = httpSyncClient(BLUETOOTH_BASE, 'k', linkFetch(link));
    fake.stop();
    // Nobody answers now; dropping the link ends the wait.
    const call = client.hello(null);
    setTimeout(() => fake.device.gatt!.disconnect(), 10);
    await expect(call).rejects.toThrow();
  });
});
