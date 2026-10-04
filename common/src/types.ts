export type ItemId = string;
export type DeviceId = string;
export type CategoryId = string;
export type UserId = string;
/** Hex-encoded SHA-256 of a file's contents. */
export type FileHash = string;

export const SCHEMA_VERSION = 4;

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

/**
 * An item's descriptive metadata beyond its title, creators, tags and identifiers (the item's own
 * fields, which operations change one at a time). The fields named here have fixed meanings and
 * shapes, covering what Calibre and EPUB's package metadata record; any other key is the user's
 * or a plugin's own (e.g. "mood", "x4:fontSize"). Values are normalized as `metadata.ts` does.
 * Typed since schema 4, which normalized the dates and numbers stored before.
 */
export interface BookMetadata {
  /** EPUB's `title-type="subtitle"`; the title doesn't repeat it. */
  subtitle?: string;
  /** How the title sorts, e.g. "Left Hand of Darkness, The" (Calibre's title sort, EPUB's title `file-as`). */
  titleSort?: string;
  /** How the authors sort, e.g. "Le Guin, Ursula K." (Calibre's author sort; EPUB's creator `file-as`, joined with " & "). */
  authorSort?: string;
  series?: string;
  /** The book's place in its series; may be fractional (2.5). */
  seriesIndex?: number;
  publisher?: string;
  /**
   * When this edition was published (EPUB's `dc:date`, Calibre's publication date), as `YYYY`,
   * `YYYY-MM` or `YYYY-MM-DD`. For an ebook this is often the ebook's own release.
   */
  published?: string;
  /** When the work itself was first published, which is what a library is usually sorted by; as `published`. */
  originallyPublished?: string;
  /** The book's main language, as a BCP 47 tag (e.g. "en", "pt-BR"). */
  language?: string;
  /** HTML, untrusted: shown with `RichText`. */
  description?: string;
  /** EPUB's `dc:rights`. */
  rights?: string;
  pages?: number;
  /** The cover's most prominent colour, as `#rrggbb`, for styling around the book. */
  coverColor?: string;
  [key: string]: MetadataValue | undefined;
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
