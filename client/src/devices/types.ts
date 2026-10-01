import type { Device, FileRef, Item } from '@nexlibris/common';
import type { Converter } from '../formats/convert/converters';
import type { FormatId } from '../formats/formats';

/** A file on a device, as its listing shows it. */
export interface RemoteFile {
  path: string;
  size: number;
}

/** How a push sync reaches a device. Paths are absolute on the device, e.g. `/Books/Dune.epub`. */
export interface DeviceTarget {
  /** Checks the device can be reached, and describes it for the UI (e.g. "X4, firmware 1.2"). */
  connect(): Promise<{ description: string }>;
  /** The files directly in a folder; none if the folder doesn't exist. */
  list(folder: string): Promise<RemoteFile[]>;
  /** Creates a folder and any missing parents. */
  ensureFolder(folder: string): Promise<void>;
  /** Writes a file, replacing any already at that path. */
  upload(path: string, data: Blob): Promise<void>;
  remove(path: string): Promise<void>;
  /** OPDS catalogs the device lists for browsing, for devices that have such a list. */
  listCatalogs?(): Promise<Catalog[]>;
  addCatalog?(catalog: Catalog): Promise<void>;
}

/** An OPDS catalog, e.g. one exported for the device and hosted somewhere. */
export interface Catalog {
  name: string;
  url: string;
}

/** A setting a device type asks for when adding or editing a device. Values are stored as strings. */
export interface SettingField {
  key: string;
  label: string;
  default: string;
  help?: string;
  /** Offered as a list of choices rather than free text. */
  choices?: { value: string; label: string }[];
  /** A whole number in this range. */
  range?: { min: number; max: number };
}

/** Turns a library file into the one sent, e.g. writing the item's current metadata into it. */
export interface Preparation {
  /** Identifies the result: the same key for the same file means the same output. Undefined if it's sent as is. */
  key(item: Item, file: FileRef): string | undefined;
  run(item: Item, file: FileRef, data: Blob): Promise<Blob>;
}

/** A kind of device, provided by a plugin. */
export interface DeviceType {
  /** Stored on devices, so it must not change: `<plugin>.<type>`, e.g. `crosspoint.x4`. */
  id: string;
  label: string;
  /** Formats to send, best first. An item with none of them isn't sent. */
  formats: FormatId[];
  settings: SettingField[];
  /** The folder on the device that books go in. */
  folder(device: Device): string;
  /**
   * Makes the format the device prefers (one of `formats`) for books that lack it, e.g. an EPUB optimized for
   * the screen. The result is kept in the library, so it's made once per source file and converter version; a
   * converter shaped by the device's settings should record them in its version.
   */
  makes?(device: Device): Converter | undefined;
  prepare?: Preparation;
  /** The device's exported catalog, as it's hosted, for the sync to add to the device's list of catalogs. */
  catalog?(device: Device): Catalog | undefined;
  target(device: Device): DeviceTarget;
}

/** Adds device types (and later other things) to nexlibris. */
export interface Plugin {
  id: string;
  name: string;
  deviceTypes: DeviceType[];
}
