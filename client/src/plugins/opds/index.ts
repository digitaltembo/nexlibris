import type { CatalogType, Plugin, SettingField, SourceType } from '../../devices/types';
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
  label: 'OPDS Static Export',
  formats: ['epub', 'pdf', 'cbz', 'cbr', 'azw3', 'mobi', 'azw', 'rtf', 'txt'],
  settings: [HOSTED_AT],
  prepare: embedMetadata,
};

/** Where a catalog to browse starts. */
const CATALOG_URL: SettingField = {
  key: 'url',
  label: 'Catalog address',
  default: '',
  help: 'The address of the catalog’s first page, e.g. https://www.gutenberg.org/ebooks.opds/ for Project Gutenberg.',
  check: (url) => {
    if (!url.trim()) return { problems: ['Give the catalog’s address.'] };
    try {
      const parsed = new URL(url.trim());
      return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? {} : { problems: ['That isn’t a web address.'] };
    } catch {
      return { problems: ['That isn’t a web address.'] };
    }
  },
};

/** How to search a catalog, where it doesn't say in a way nexlibris can read. */
const SEARCH_TEMPLATE: SettingField = {
  key: 'search',
  label: 'Search address (optional)',
  default: '',
  help: 'Only needed if the catalog’s own search can’t be read here: its search page’s address with {searchTerms} where the words go, e.g. https://www.gutenberg.org/ebooks/search.opds/?query={searchTerms} for Project Gutenberg in a browser.',
  check: (template) => {
    if (!template.trim()) return {};
    if (!template.includes('{searchTerms}')) return { problems: ['Put {searchTerms} where the words go.'] };
    try {
      const parsed = new URL(template.trim().replace('{searchTerms}', 'x'));
      return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? {} : { problems: ['That isn’t a web address.'] };
    } catch {
      return { problems: ['That isn’t a web address.'] };
    }
  },
};

/** An OPDS catalog on a server, browsed and searched, with books added to the library from it; nothing is sent there. */
export const opdsServer: SourceType = {
  kind: 'source',
  id: 'opds.server',
  label: 'OPDS server',
  formats: [],
  settings: [CATALOG_URL, SEARCH_TEMPLATE],
  url: (device) => String(device.settings?.url ?? '').trim(),
  searchTemplate: (device) => String(device.settings?.search ?? '').trim() || undefined,
};

/** OPDS catalogs: written as static files for any web host (calibre3opds's layout), or browsed on a server. */
export const opds: Plugin = {
  id: 'opds',
  name: 'OPDS',
  connectionTypes: [opdsCatalog, opdsServer],
};
