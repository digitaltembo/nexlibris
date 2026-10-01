export type ItemId = string;
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

export interface UserData {
  /** 0–5. */
  ratings: Record<ItemId, number>;
  reviews: Record<ItemId, Review>;
}

export interface Library {
  schemaVersion: typeof SCHEMA_VERSION;
  id: string;
  name: string;
  /** Bumped once per applied operation. */
  revision: number;
  items: Record<ItemId, Item>;
  userData: Record<UserId, UserData>;
}
