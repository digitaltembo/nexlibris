import {
  BLUETOOTH_REQUESTS,
  BLUETOOTH_RESPONSES,
  BLUETOOTH_SERVICE,
  BLUETOOTH_WRITE_SIZE,
  chunkMessage,
  MessageAssembler,
  messageFetch,
} from '@nexlibris/common';
import { inMobileApp } from '../backends/mobileBridge';

/**
 * Reaching a hub over Bluetooth (see `common/src/bluetoothApi.ts`): the Android app, hosting sync,
 * connected to with Web Bluetooth (Chrome, Edge and the desktop app). Each sync call is a message
 * (`syncMessage.ts`); `linkFetch` makes `fetch` calls that way, so `httpSyncClient` and `httpHubFiles`
 * work over it unchanged.
 */

/** Pairings over Bluetooth have addresses `bluetooth:<the phone's name>`. */
export const BLUETOOTH_PREFIX = 'bluetooth:';
export const isBluetoothAddress = (address: string) => address.startsWith(BLUETOOTH_PREFIX);
/** What `httpSyncClient` and `httpHubFiles` are given as the hub's address; the link already leads there. */
export const BLUETOOTH_BASE = 'http://bluetooth.invalid';

/** How long a response may go without a chunk arriving before the call is given up. */
const IDLE_TIMEOUT_MS = 30_000;

// The parts of Web Bluetooth used here (it isn't in TypeScript's DOM types).
export interface GattCharacteristic extends EventTarget {
  value?: DataView;
  writeValueWithResponse(value: BufferSource): Promise<void>;
  startNotifications(): Promise<GattCharacteristic>;
}
export interface GattServer {
  connected: boolean;
  connect(): Promise<GattServer>;
  disconnect(): void;
  getPrimaryService(uuid: string): Promise<{ getCharacteristic(uuid: string): Promise<GattCharacteristic> }>;
}
export interface BluetoothDeviceLike extends EventTarget {
  id: string;
  name?: string;
  gatt?: GattServer;
}
interface WebBluetooth {
  getAvailability?(): Promise<boolean>;
  requestDevice(options: { filters: { services: string[] }[] }): Promise<BluetoothDeviceLike>;
}
const webBluetooth = () => (navigator as Navigator & { bluetooth?: WebBluetooth }).bluetooth;

/** Whether this browser can reach a hub over Bluetooth. The phone apps are the hub, so they don't. */
export const canSyncOverBluetooth = () => typeof navigator !== 'undefined' && !!webBluetooth() && !inMobileApp();

export interface BluetoothLink {
  /** The phone's name, as it advertises itself. */
  name: string;
  exchange(message: Uint8Array): Promise<Uint8Array>;
  connected(): boolean;
  /** Connects to the same phone again, as a new link: no chooser needed. */
  reconnect(): Promise<BluetoothLink>;
  close(): void;
}

/** Asks which phone to connect to (the browser's chooser, which needs a click to be under way), then connects. */
export async function chooseBluetoothHub(): Promise<BluetoothLink> {
  const bluetooth = webBluetooth();
  if (!bluetooth) throw new Error('This browser can’t use Bluetooth. Try Chrome or Edge, or the desktop app.');
  let device: BluetoothDeviceLike;
  try {
    device = await bluetooth.requestDevice({ filters: [{ services: [BLUETOOTH_SERVICE] }] });
  } catch (e) {
    if (e instanceof DOMException && e.name === 'NotFoundError') throw new Error('No phone was chosen.');
    throw e;
  }
  return connect(device);
}

/** Connects to a device the user chose (exported for tests, which pass a stand-in). */
export async function connect(device: BluetoothDeviceLike): Promise<BluetoothLink> {
  const name = device.name || 'Phone';
  if (!device.gatt) throw new Error(`${name} can’t be connected to.`);
  let requests: GattCharacteristic;
  let responses: GattCharacteristic;
  try {
    const server = await device.gatt.connect();
    const service = await server.getPrimaryService(BLUETOOTH_SERVICE);
    requests = await service.getCharacteristic(BLUETOOTH_REQUESTS);
    responses = await service.getCharacteristic(BLUETOOTH_RESPONSES);
  } catch (e) {
    throw new Error(`Couldn’t connect to ${name}: ${e instanceof Error ? e.message : String(e)}. Check that sync over Bluetooth is on there.`);
  }
  const assembler = new MessageAssembler();
  let waiting: { resolve(message: Uint8Array): void; reject(error: Error): void; touch(): void } | undefined;

  responses.addEventListener('characteristicvaluechanged', () => {
    const view = responses.value;
    if (!view) return;
    waiting?.touch();
    const message = assembler.push(new Uint8Array(view.buffer, view.byteOffset, view.byteLength).slice());
    if (message && waiting) {
      const done = waiting;
      waiting = undefined;
      done.resolve(message);
    }
  });
  device.addEventListener('gattserverdisconnected', () => {
    assembler.reset();
    waiting?.reject(new Error(`The Bluetooth connection to ${name} dropped.`));
    waiting = undefined;
  });
  await responses.startNotifications();

  // One call at a time: the hub answers each before the next is sent.
  let queue: Promise<unknown> = Promise.resolve();
  const exchange = (message: Uint8Array) => {
    const call = queue.then(async () => {
      if (!device.gatt?.connected) throw new Error(`Not connected to ${name}.`);
      const reply = new Promise<Uint8Array>((resolve, reject) => {
        let timer: ReturnType<typeof setTimeout>;
        const touch = () => {
          clearTimeout(timer);
          timer = setTimeout(() => {
            waiting = undefined;
            assembler.reset();
            reject(new Error(`${name} stopped answering over Bluetooth.`));
          }, IDLE_TIMEOUT_MS);
        };
        waiting = {
          resolve: (m) => (clearTimeout(timer), resolve(m)),
          reject: (e) => (clearTimeout(timer), reject(e)),
          touch,
        };
        touch();
      });
      for (const chunk of chunkMessage(message, BLUETOOTH_WRITE_SIZE)) {
        await requests.writeValueWithResponse(chunk);
        waiting?.touch();
      }
      return reply;
    });
    queue = call.catch(() => undefined);
    return call;
  };
  return {
    name,
    exchange,
    connected: () => !!device.gatt?.connected,
    reconnect: () => connect(device),
    close: () => device.gatt?.disconnect(),
  };
}

/** `fetch` over a link, for `httpSyncClient` and `httpHubFiles` with `BLUETOOTH_BASE` as the address. */
export const linkFetch = (link: BluetoothLink) => messageFetch((message) => link.exchange(message));

/** Links open this session, by hub origin, so a sync and the files fetched when books open reuse them. */
const links = new Map<string, BluetoothLink>();

export const rememberLink = (hubOrigin: string, link: BluetoothLink) => links.set(hubOrigin, link);

/**
 * The link to a paired hub: the one open this session, or a new one chosen in the browser's
 * chooser, which needs a click under way (`interactive`).
 */
export async function bluetoothLink(hubOrigin: string, interactive: boolean): Promise<BluetoothLink> {
  const open = links.get(hubOrigin);
  if (open?.connected()) return open;
  if (open) {
    try {
      const again = await open.reconnect();
      links.set(hubOrigin, again);
      return again;
    } catch (e) {
      if (!interactive) throw e;
    }
  }
  if (!interactive) throw new Error('Sync over Bluetooth first.');
  const link = await chooseBluetoothHub();
  links.set(hubOrigin, link);
  return link;
}
