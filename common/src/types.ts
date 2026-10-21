import type { BookMetadata, Creator, MetadataValue } from '@nexlibris/tools/metadata';

/** The metadata of books, as their files and the library both keep it: part of the stored shape (see `SCHEMA_VERSION`). */
export type { BookMetadata, Creator, MetadataValue };

export type ItemId = string;
export type DeviceId = string;
export type CategoryId = string;
export type UserId = string;
/** Hex-encoded SHA-256 of a file's contents. */
export type FileHash = string;

export const SCHEMA_VERSION = 9;

/** The implicit user until multi-user support exists. */
export const LOCAL_USER: UserId = 'local';

export type ItemKind = 'book' | 'audio' | 'video';

export interface FileRef {
  hash: FileHash;
  /** e.g. 'epub', 'x4.epub', 'mp3'. */
  format: string;
  size: number;
  /** The filename it was imported under, for display and export. */
  name?: string;
  derivedFrom?: { hash: FileHash; converter: string; converterVersion: string };
  /**
   * The fingerprint (`metadataKey` in `client/src/library/fileMetadata.ts`) of the item's metadata as
   * written into this file: set when it's imported saying what the item says, made by a converter, or
   * rewritten by Clean up. A file whose key differs from its item's is behind its metadata. Unset when
   * not known (files from before schema 9, formats nexlibris can't write metadata into).
   */
  metadataKey?: string;
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
  metadata: BookMetadata;
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
  /**
   * Taken out of Currently Reading by the user, keeping the place. Reading it again saves a new
   * position without it, which brings the book back.
   */
  setAside?: boolean;
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
  /** Of the file as sent. Since schema 9 files are sent as stored, so it's the library file's; earlier syncs wrote metadata into them. */
  size: number;
  /**
   * Put there by hand and linked to the item, rather than sent by a sync: it stays at its own path
   * while it's current, where a sent file moves when the device's path templates change.
   */
  linked?: boolean;
  /**
   * A copy nexlibris didn't send (linked, or found on the device by a sync): it stands for the library file
   * in `hash` as is, so it's current while that file is unchanged.
   */
  found?: boolean;
}

/**
 * A connection: somewhere the library goes or reads from (a reader, a folder, an OPDS catalog,
 * another instance of nexlibris). What it is and how it's reached come from its connection type
 * (`client/src/devices/types.ts`). The model still calls connections devices.
 *
 * A connection that's written to has a catalog: the books it holds, chosen by hand (`items`, or
 * particular files of them, `files`) and added by its search (`query`) as they match, which stay
 * once added. Syncs only ever add to what's there; removing is the user's.
 */
export interface Device {
  id: DeviceId;
  name: string;
  /** A connection type, e.g. 'crosspoint.reader'. */
  type: string;
  /** The connection's catalog: the items in it, in the order they were added. */
  items: ItemId[];
  /**
   * Items in the catalog by particular files (added with "Add to…" on a file): only these files of
   * theirs go there, rather than the one the type's formats pick. Added in schema 9.
   */
  files?: Record<ItemId, FileHash[]>;
  /** A search (the library search box's syntax) whose matches are added to the catalog. */
  query?: string;
  /**
   * Items taken out of the catalog that its search would add again, so it doesn't; for another
   * instance, also books deleted there, which stay in this library.
   */
  excluded?: ItemId[];
  /** Settings for the connection type, e.g. its address. Their meaning is up to the type. */
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
  /** Bumped once per applied operation. Local to this instance: another copy of the library counts its own. */
  revision: number;
  /**
   * This instance's ID (a UUID), recorded on every change made here, so changes from different instances
   * of one library (M6 sync) never share an ID. Belongs to the copy, not the library: it isn't carried
   * across by restoring a backup, and a copy made another way (e.g. a copied folder) must get a new one.
   * Added in schema 2.
   */
  origin: string;
  items: Record<ItemId, Item>;
  userData: Record<UserId, UserData>;
  /** Added after schema version 1 shipped, so older libraries don't have it. */
  devices?: Record<DeviceId, Device>;
  /** Browse categories of the user's own. Added in schema 3. */
  categories?: Record<CategoryId, Category>;
}

/**
 * A browse category of the user's own, as calibre3opds's customization: a name for a list of
 * named searches, each opening the books it matches. A category with one entry opens its books
 * directly. Searches use the search box's syntax (`client/src/library/search.ts`), so an entry
 * can be one tag (`tag:Fantasy`), as in calibre3opds, or anything else that can be searched for.
 */
export interface Category {
  id: CategoryId;
  name: string;
  entries: CategoryEntry[];
}

export interface CategoryEntry {
  label: string;
  query: string;
}
