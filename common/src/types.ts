export type ItemId = string;
export type DeviceId = string;
export type UserId = string;
/** Hex-encoded SHA-256 of a file's contents. */
export type FileHash = string;

export const SCHEMA_VERSION = 1;

/** The implicit user until multi-user support exists. */
export const LOCAL_USER: UserId = 'local';

export type ItemKind = 'book' | 'audio' | 'video';

export interface Creator {
  name: string;
  /** MARC relator code, e.g. 'aut', 'edt', 'trl'. */
  role: string;
}

/** JSON-compatible value, used for arbitrary item metadata. */
export type MetadataValue = string | number | boolean | null | MetadataValue[] | { [key: string]: MetadataValue };

export interface FileRef {
  hash: FileHash;
  /** e.g. 'epub', 'x4.epub', 'mp3'. */
  format: string;
  size: number;
  /** The filename it was imported under, for display and export. */
  name?: string;
  derivedFrom?: { hash: FileHash; converter: string; converterVersion: string };
}

export interface Cover {
  hash: FileHash;
  mediaType: string;
}

export interface Item {
  id: ItemId;
  kind: ItemKind;
  title: string;
  creators: Creator[];
  /** isbn, openlibrary, uuid, … */
  identifiers: Record<string, string>;
  /** Free-form labels, unique case-insensitively, in the order they were added. */
  tags: string[];
  /** Arbitrary, namespaced keys, e.g. "series", "x4:fontSize". */
  metadata: Record<string, MetadataValue>;
  /** May be empty: items can be cataloged without owning a file. */
  files: FileRef[];
  cover?: Cover;
  addedAt: string;
  updatedAt: string;
}

export interface Review {
  text: string;
  updatedAt: string;
}

/** Where a user is in an item: in one particular file, since positions don't carry across formats. */
export interface ReadingPosition {
  hash: FileHash;
  /** Meaningful to the viewer for the file's format, e.g. an EPUB CFI or a page number. */
  locator: string;
  /** How far through, 0–1, when the viewer knows. */
  progress?: number;
  updatedAt: string;
}

export interface UserData {
  /** 0–5. */
  ratings: Record<ItemId, number>;
  reviews: Record<ItemId, Review>;
  /** Added after schema version 1 shipped, so older libraries don't have it. */
  positions?: Record<ItemId, ReadingPosition>;
}

/** A file a sync put on a device. Only these are ever replaced or removed by later syncs. */
export interface PlacedFile {
  itemId: ItemId;
  /** The library file it was made from. */
  hash: FileHash;
  /** Of the file as sent, which can differ from the library's (see `key`). */
  size: number;
  /**
   * How the device type prepared the file from the library's, e.g. a fingerprint
   * of the metadata written into it. The file is sent again when this changes.
   */
  key?: string;
}

/**
 * A reader the library sends books to, e.g. a CrossPoint X4. What the device
 * is and how it's reached come from a plugin's device type.
 */
export interface Device {
  id: DeviceId;
  name: string;
  /** A plugin's device type, e.g. 'crosspoint.x4'. */
  type: string;
  /** The items chosen to be on the device, in the order they were added. */
  items: ItemId[];
  /** A search (the library search box's syntax) whose matches also go on the device, as they change. */
  query?: string;
  /** Settings for the device type, e.g. its address. Their meaning is up to the plugin. */
  settings: Record<string, MetadataValue>;
  /** What syncs have put on the device, by path on the device. */
  placed: Record<string, PlacedFile>;
  lastSyncedAt?: string;
  addedAt: string;
}

export interface Library {
  schemaVersion: typeof SCHEMA_VERSION;
  id: string;
  name: string;
  /** Bumped once per applied operation. */
  revision: number;
  items: Record<ItemId, Item>;
  userData: Record<UserId, UserData>;
  /** Added after schema version 1 shipped, so older libraries don't have it. */
  devices?: Record<DeviceId, Device>;
}
