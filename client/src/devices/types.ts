import type { Device, FileRef, Item, Library } from '@nexlibris/common';
import type { Converter } from '../formats/convert/converters';
import type { FormatId } from '../formats/formats';
import type { ComponentType } from 'react';
import type { LibraryViewType } from '../views/types';

/** A file on a device, as its listing shows it. */
export interface RemoteFile {
  path: string;
  size: number;
}

/** A book on a connection, with what the connection knows of it (a reader's own index, say). */
export interface RemoteBook extends RemoteFile {
  title?: string;
  author?: string;
  series?: string;
  seriesIndex?: string;
  tags?: string[];
  /** When it arrived there, as an ISO timestamp. */
  modified?: string;
}

/** Everything on a device, for showing what's there (see `contents.ts`). */
export interface Inventory {
  /** Newest first, where the device knows the order. */
  books: RemoteBook[];
  /** Something to say about the listing, e.g. that it's from file names only. */
  note?: string;
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
  /** Reads a file, e.g. to bring a book on the device into the library. */
  download?(path: string): Promise<Blob>;
  /** Moves or renames a file, into a folder that exists; without it, a book whose path changes is sent again. */
  move?(from: string, to: string): Promise<void>;
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
  /** Checks a value as it's typed (with the connection's other settings), giving problems and an example of its effect. */
  check?(value: string, settings: Record<string, string>, library: Library): { problems?: string[]; example?: string };
}

/** Turns a library file into the one sent, e.g. writing the item's current metadata into it. */
export interface Preparation {
  /** Identifies the result: the same key for the same file means the same output. Undefined if it's sent as is. */
  key(item: Item, file: FileRef): string | undefined;
  run(item: Item, file: FileRef, data: Blob): Promise<Blob>;
}

/**
 * What every kind of connection has. A connection is stored as a `Device` in the library (the
 * model's name for it, kept so libraries needn't migrate), and its type says what it is.
 */
interface ConnectionTypeBase {
  /** Stored on connections, so it must not change: `<plugin>.<type>`, e.g. `crosspoint.x4`. */
  id: string;
  label: string;
  /** Formats to send, best first. An item with none of them isn't sent. (An instance takes every format.) */
  formats: FormatId[];
  settings: SettingField[];
  /**
   * Makes the format the device prefers (one of `formats`) for books that lack it, e.g. an EPUB optimized for
   * the screen. The result is kept in the library, so it's made once per source file and converter version; a
   * converter shaped by the device's settings should record them in its version.
   */
  makes?(device: Device): Converter | undefined;
  prepare?: Preparation;
}

/** A reader or other device that books are copied to, provided by a plugin. */
export interface DeviceType extends ConnectionTypeBase {
  kind?: 'device';
  /**
   * Where books go on the device: a path template (`devices/pathTemplate.ts`), a plain folder such as
   * `/Books` or one with the book's details such as `/library/<author>/<title>`.
   */
  folder(device: Device): string;
  /** Books' file names, as a template without the extension; `<title>[ - <author>]` if not given. */
  fileName?(device: Device): string;
  /** The device's exported catalog, as it's hosted, for the sync to add to the device's list of catalogs. */
  catalog?(device: Device): Catalog | undefined;
  target(device: Device): DeviceTarget;
  /** Everything on the device, with what it knows of each book; without it, the sync folders' files are listed. */
  /** Everything on the device; `listing`, the sync folders' files (`listDevice`), saves listing them again. */
  inventory?(device: Device, target: DeviceTarget, library: Library, listing?: RemoteFile[]): Promise<Inventory>;
  /** Other things kept on the device, each managed on its own tab beside its books (a reader's fonts, say). */
  tools?: DeviceTool[];
}

/**
 * Something on a device other than books, with its own tab where the device's contents are shown.
 * The component connects to the device itself, as it needs.
 */
export interface DeviceTool {
  id: string;
  /** The tab's name. */
  label: string;
  component: ComponentType<{ device: Device }>;
}

/**
 * A static OPDS catalog of the connection's books, written to a folder or a zip for hosting
 * (`devices/opds/`). Syncing it writes the catalog again.
 */
export interface CatalogType extends ConnectionTypeBase {
  kind: 'catalog';
}

/**
 * Another instance of nexlibris that the library syncs with (M6). Its connection's id is that
 * instance's origin, and its books are the ones whose files it keeps; how this instance reaches
 * it (the pairing: address, key, where they last agreed) is kept here only, outside the library.
 */
export interface InstanceType extends ConnectionTypeBase {
  kind: 'instance';
}

export type ConnectionType = DeviceType | CatalogType | InstanceType;

export const isCatalog = (type: ConnectionType): type is CatalogType => type.kind === 'catalog';
export const isInstance = (type: ConnectionType): type is InstanceType => type.kind === 'instance';
export const isDevice = (type: ConnectionType): type is DeviceType => !type.kind || type.kind === 'device';

/** Adds connection types (and later other things) to nexlibris. */
export interface Plugin {
  id: string;
  name: string;
  connectionTypes: ConnectionType[];
  /** Ways of showing the books, beside grid and list. */
  views?: LibraryViewType[];
}
