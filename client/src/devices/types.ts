import type { Device, Item, Library, LibraryBackend } from '@nexlibris/common';
import type { Converter } from '@nexlibris/tools/formats/convert/converters';
import type { FormatId, FormatInfo } from '@nexlibris/tools/formats/formats';
import type { OptionField } from '@nexlibris/tools/options';
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

/** A setting a connection type asks for when adding or editing a connection. Values are stored as strings. */
export interface SettingField extends OptionField {
  /** Checks a value as it's typed (with the connection's other settings), giving problems and an example of its effect. */
  check?(value: string, settings: Record<string, string>, library: Library): { problems?: string[]; example?: string };
}

/** A connection's setting, or its default. */
export function settingOf(device: Device, field: SettingField): string {
  const value = device.settings[field.key];
  return typeof value === 'string' && value.trim() ? value.trim() : field.default;
}

/** A `some` setting's choices as picked: all of them when none are. */
export function pickedChoices(device: Device, field: SettingField): string[] {
  const all = (field.choices ?? []).map((c) => c.value);
  const picked = settingOf(device, field)
    .split(',')
    .map((v) => v.trim())
    .filter((v) => all.includes(v));
  return picked.length ? picked : all;
}

/**
 * What every kind of connection has. A connection is stored as a `Device` in the library (the
 * model's name for it, kept so libraries needn't migrate), and its type says what it is and what
 * it can do:
 *
 * - it **reads** (`read`): its books can be listed, organized as it organizes them, and downloaded
 *   into the library, under "On it…" and in the Library;
 * - it **writes** (`write`): it has a catalog (the books chosen for it by hand, and added by its
 *   search), which "Sync to" sends there and "Add to…" adds to, and which "Send to…" also sends
 *   at once where it takes single books. Syncs only ever add (and replace the files they sent that
 *   have changed since); what goes from there is up to the user;
 * - or both, when it also has "Sync from", downloading everything there that the library lacks.
 *
 * Sending never converts or rewrites a file: a connection gets the library's files as they are.
 * One that prefers formats books lack asks first whether to convert them (`send.ts`).
 */
interface ConnectionTypeBase {
  /** Stored on connections, so it must not change: `<plugin>.<type>`, e.g. `crosspoint.reader`. */
  id: string;
  label: string;
  /** Formats it takes, best first: a book with none of them isn't sent. Empty for one that takes every format. */
  formats(device: Device): FormatId[];
  /**
   * The formats it's meant to get, if it prefers some (a reader's optimized EPUB): a book without one,
   * where a converter can make it, is asked about before it's sent (`send.ts`).
   */
  preferred?(device: Device): FormatId[];
  settings: SettingField[];
  /** Why it can't be used here, if it can't (a folder needs a browser that can be given folders). */
  unavailable?(): string | undefined;
  /**
   * When it's active on this device, which puts it in the Library and lets books be sent to it
   * (`connections/active.ts`): `always` (the default), `manual` (activated and deactivated by hand,
   * as a reader or another instance is while it's around), or checked: why it isn't, or undefined.
   */
  activation?: 'always' | 'manual' | ((device: Device) => Promise<string | undefined>);
  /** Reads: lists what's there, and brings books in. */
  read?: true;
  /** Writes: has a catalog. `single`: books can be sent one at a time (Send to…), not only by syncing all of it. */
  write?: { single: boolean };
}

/**
 * Somewhere books are kept as files at paths: a reader (a plugin's), or a folder (`connections/folder/`).
 * It writes books there by the path templates, and reads what's there.
 */
export interface FilesType extends ConnectionTypeBase {
  access: 'files';
  /**
   * Where books go: a path template (`devices/pathTemplate.ts`), a plain folder such as `/Books` or
   * one with the book's details such as `/library/<author>/<title>`.
   */
  folder(device: Device): string;
  /** Books' file names, as a template without the extension; `<title>[ - <author>]` if not given. */
  fileName?(device: Device): string;
  /**
   * The extension a file gets from its format: its last part (`epub` for `x4.epub`, as readers take
   * them as any EPUB) unless `fullExtension`, which keeps it whole, so the format reads back.
   */
  fullExtension?: boolean;
  /** Every file a book has in its formats goes, rather than the first by them (a backup's). */
  everyFormat?: boolean;
  /** Where it is is a folder the user picks on this computer, remembered here (`connections/folder/`). */
  pickFolder?: true;
  /** An exported catalog to add to the device's list of catalogs as it syncs. */
  catalog?(device: Device): Catalog | undefined;
  target(device: Device): DeviceTarget;
  /** Everything there, with what it knows of each book; `listing`, the sync folders' files (`listDevice`), saves listing them again. */
  inventory?(device: Device, target: DeviceTarget, library: Library, listing?: RemoteFile[]): Promise<Inventory>;
  /** Brings a book there into the library as the connection describes it, rather than as its file says. */
  download?(device: Device, target: DeviceTarget, book: RemoteBook, backend: LibraryBackend): Promise<Item | undefined>;
  /** Other things kept on the device, each managed on its own tab beside its books (a reader's fonts, say). */
  tools?: DeviceTool[];
  /** Called after a sync or send there, with the library as it now is, e.g. to write a manifest of what's there. */
  afterSync?(device: Device, target: DeviceTarget, library: Library, backend: LibraryBackend): Promise<void>;
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
 * A static OPDS catalog of the connection's catalog, written to a folder or a zip for hosting
 * (`devices/opds/`). It's only ever synced whole.
 */
export interface ExportType extends ConnectionTypeBase {
  access: 'export';
}

/**
 * Another instance of nexlibris (M6). Its connection's id is that instance's origin, and its
 * catalog is the books it's shown: what it can browse and download from this one, and what
 * "Sync to" sends it; how this instance reaches it (the pairing: address, key, where they last
 * agreed) is kept here only, outside the library.
 */
export interface InstanceType extends ConnectionTypeBase {
  access: 'instance';
}

/**
 * A catalog on a server that's browsed: its books are shown under "On it…" and in the Library
 * (`Library / <name>`), and can be downloaded into the library, but nothing is sent to it. `url`
 * is where its catalog starts.
 */
export interface FeedType extends ConnectionTypeBase {
  access: 'feed';
  url(device: Device): string;
  /** A search template (`{searchTerms}`) set for it, overriding what the catalog says, if any. */
  searchTemplate?(device: Device): string | undefined;
}

/**
 * An OPDS feed of the connection's catalog, served live by the nexlibris server whose account holds
 * the library (`common/src/opdsServer.ts`, at `/opds/<id>/`): nothing is written or synced, as the
 * server reads the account's library at every request. Active only while signed in to a server.
 */
export interface ServedType extends ConnectionTypeBase {
  access: 'served';
}

export type ConnectionType = FilesType | ExportType | InstanceType | FeedType | ServedType;

export const isFiles = (type: ConnectionType): type is FilesType => type.access === 'files';
export const isExport = (type: ConnectionType): type is ExportType => type.access === 'export';
export const isInstance = (type: ConnectionType): type is InstanceType => type.access === 'instance';
export const isFeed = (type: ConnectionType): type is FeedType => type.access === 'feed';
export const isServed = (type: ConnectionType): type is ServedType => type.access === 'served';

/** Whether a connection type reads, writes, or takes single books. */
export const reads = (type: ConnectionType) => !!type.read;
export const writes = (type: ConnectionType) => !!type.write;
export const takesSingle = (type: ConnectionType) => !!type.write?.single;

/** Adds connection types, views, formats and converters to nexlibris. */
export interface Plugin {
  id: string;
  name: string;
  connectionTypes: ConnectionType[];
  /** Ways of showing the books, beside grid and list. */
  views?: LibraryViewType[];
  /**
   * Formats it adds, by id, and converters making them. They're registered with `@nexlibris/tools` by
   * `plugins/formats.ts`, which loads without the plugins' UI; list them in both.
   */
  formats?: Partial<Record<FormatId, FormatInfo>>;
  converters?: Converter[];
}
