import { OPDS_SERVED_TYPE, type Device } from '@nexlibris/common';
import { pickedChoices, type ExportType, type FeedType, type ServedType, type SettingField } from '../devices/types';
import { FORMATS, type FormatId } from '@nexlibris/tools/formats/formats';
import { serverSession, serverUrl } from '../library/account';

/** Where a catalog is hosted, for showing it; nothing is uploaded there. */
export const HOSTED_AT: SettingField = {
  key: 'url',
  label: 'Hosted at',
  default: '',
  help: 'The address the catalog is served from, if you host it. Sync writes the files; putting them online is up to you.',
};

/** Which formats of each book the catalog offers. */
export const EXPORT_FORMATS: SettingField = {
  key: 'formats',
  label: 'Formats',
  kind: 'some',
  default: '',
  choices: (Object.keys(FORMATS) as FormatId[]).map((format) => ({ value: format, label: FORMATS[format].label })),
  help: 'Each book is offered in every format it has, or, if you pick some, in every one of those it has; a book with none of them is left out.',
};

/** calibre3opds's Cloudflare Pages options (`devices/opds/cloudflare/`). */
export const SEARCH_ROUTING: SettingField = {
  key: 'searchRouting',
  label: 'Cloudflare search routing',
  kind: 'checkbox',
  default: 'no',
  help: 'Lets OPDS readers search as they type when the catalog is hosted on Cloudflare Pages: writes a Pages Function and a search index.',
};

export const BASIC_AUTH: SettingField = {
  key: 'basicAuth',
  label: 'Cloudflare Basic Auth',
  kind: 'checkbox',
  default: 'no',
  help: 'Puts a user name and password in front of the whole catalog on Cloudflare Pages: writes _worker.js. Set them as the BASIC_USER and BASIC_PASS secrets of the Pages project (see README.md in the catalog).',
};

/**
 * A static OPDS catalog of the connection's catalog, in calibre3opds's layout, written to a folder or a zip
 * for any web host. Only ever synced whole; each book in every one of its formats, as stored.
 */
export const opdsExport: ExportType = {
  access: 'export',
  id: 'opds.catalog',
  label: 'OPDS Static Export',
  write: { single: false },
  formats: (device) => pickedChoices(device, EXPORT_FORMATS) as FormatId[],
  settings: [HOSTED_AT, EXPORT_FORMATS, SEARCH_ROUTING, BASIC_AUTH],
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

/** An OPDS catalog on a server, browsed and searched, with books downloaded into the library from it; nothing is sent there. */
export const opdsServer: FeedType = {
  access: 'feed',
  id: 'opds.server',
  label: 'OPDS server',
  read: true,
  formats: () => [],
  settings: [CATALOG_URL, SEARCH_TEMPLATE],
  url: (device) => String(device.settings?.url ?? '').trim(),
  searchTemplate: (device) => String(device.settings?.search ?? '').trim() || undefined,
};

/** Which formats of each book a served feed offers (`servedFormats` in `common/src/opdsServer.ts` reads it). */
const SERVED_FORMATS: SettingField = {
  key: 'formats',
  label: 'Formats',
  kind: 'some',
  default: '',
  choices: (Object.keys(FORMATS) as FormatId[]).map((format) => ({ value: format, label: FORMATS[format].label })),
  help: 'Each book is offered in every format it has, or, if you pick some, in every one of those it has; a book with none of them is left out.',
};

/** Where the server serves a feed, while signed in to one. */
export function servedFeedUrl(device: Device): string | undefined {
  const server = serverUrl();
  return server && `${server.replace(/\/$/, '')}/opds/${encodeURIComponent(device.id)}/`;
}

/**
 * An OPDS feed of the connection's catalog, served live by the nexlibris server the library's account
 * is on, as OPDS 1.2 (XML) or 2.0 (JSON), for OPDS readers signing in with the account's name and
 * password. Nothing is sent or synced: the server reads the library as it is. Active only while
 * signed in to a server, as only there is it served.
 */
export const opdsServed: ServedType = {
  access: 'served',
  id: OPDS_SERVED_TYPE,
  label: 'OPDS feed on your server',
  write: { single: false },
  formats: (device) => pickedChoices(device, SERVED_FORMATS) as FormatId[],
  settings: [SERVED_FORMATS],
  activation: async () => ((await serverSession())?.account ? undefined : 'Sign in to a nexlibris server (Account…) to serve it'),
};
