import type { CatalogType, Plugin, SettingField } from '../../devices/types';
import { embedMetadata } from '../../devices/embedMetadata';

/** Where a catalog is hosted, for showing it; nothing is uploaded there. */
export const HOSTED_AT: SettingField = {
  key: 'url',
  label: 'Hosted at',
  default: '',
  help: 'The address the catalog is served from, if you host it. Sync writes the files; putting them online is up to you.',
};

/** A static OPDS catalog with every format each book has, the item's current metadata written into EPUBs. */
export const opdsCatalog: CatalogType = {
  kind: 'catalog',
  id: 'opds.catalog',
  label: 'OPDS catalog',
  formats: ['epub', 'pdf', 'cbz', 'cbr', 'azw3', 'mobi', 'azw', 'rtf', 'txt'],
  settings: [HOSTED_AT],
  prepare: embedMetadata,
};

/** OPDS catalogs, written as static files for any web host (calibre3opds's layout). */
export const opds: Plugin = {
  id: 'opds',
  name: 'OPDS',
  connectionTypes: [opdsCatalog],
};
