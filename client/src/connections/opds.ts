import { OPDS_SERVED_TYPE, type Device } from '@nexlibris/common';
import { pickedChoices, type ExportType, type FeedType, type ServedType, type SettingField } from '../devices/types';
import { FORMATS, type FormatId } from '@nexlibris/tools/formats/formats';
import { serverSession, serverUrl } from '../library/account';
import { t } from '../i18n';

/** Where a catalog is hosted, for showing it; nothing is uploaded there. */
export const HOSTED_AT: SettingField = {
  key: 'url',
  label: t('connectionTypes.opds.hostedAt'),
  default: '',
  help: t('connectionTypes.opds.hostedAtHelp'),
};

/** Which formats of each book the catalog offers. */
export const EXPORT_FORMATS: SettingField = {
  key: 'formats',
  label: t('connectionTypes.formats'),
  kind: 'some',
  default: '',
  choices: (Object.keys(FORMATS) as FormatId[]).map((format) => ({ value: format, label: FORMATS[format].label })),
  noun: { one: t('connectionTypes.formatNoun.one'), many: t('connectionTypes.formatNoun.many') },
  help: t('connectionTypes.opds.formatsHelp'),
};

/** calibre3opds's Cloudflare Pages options (`devices/opds/cloudflare/`). */
export const SEARCH_ROUTING: SettingField = {
  key: 'searchRouting',
  label: t('connectionTypes.opds.searchRouting'),
  kind: 'checkbox',
  default: 'no',
  help: t('connectionTypes.opds.searchRoutingHelp'),
};

export const BASIC_AUTH: SettingField = {
  key: 'basicAuth',
  label: t('connectionTypes.opds.basicAuth'),
  kind: 'checkbox',
  default: 'no',
  help: t('connectionTypes.opds.basicAuthHelp'),
};

/**
 * A static OPDS catalog of the connection's catalog, in calibre3opds's layout, written to a folder or a zip
 * for any web host. Only ever synced whole; each book in every one of its formats, as stored.
 */
export const opdsExport: ExportType = {
  access: 'export',
  id: 'opds.catalog',
  label: t('connectionTypes.opds.export'),
  write: { single: false },
  formats: (device) => pickedChoices(device, EXPORT_FORMATS) as FormatId[],
  settings: [HOSTED_AT, EXPORT_FORMATS, SEARCH_ROUTING, BASIC_AUTH],
};

/** Where a catalog to browse starts. */
const CATALOG_URL: SettingField = {
  key: 'url',
  label: t('connectionTypes.opds.catalogAddress'),
  default: '',
  help: t('connectionTypes.opds.catalogAddressHelp'),
  check: (url) => {
    if (!url.trim()) return { problems: [t('connectionTypes.opds.giveAddress')] };
    try {
      const parsed = new URL(url.trim());
      return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? {} : { problems: [t('connectionTypes.notWebAddress')] };
    } catch {
      return { problems: [t('connectionTypes.notWebAddress')] };
    }
  },
};

/** How to search a catalog, where it doesn't say in a way nexlibris can read. */
const SEARCH_TEMPLATE: SettingField = {
  key: 'search',
  label: t('connectionTypes.opds.searchAddress'),
  default: '',
  help: t('connectionTypes.opds.searchAddressHelp'),
  check: (template) => {
    if (!template.trim()) return {};
    if (!template.includes('{searchTerms}')) return { problems: [t('connectionTypes.opds.searchTerms')] };
    try {
      const parsed = new URL(template.trim().replace('{searchTerms}', 'x'));
      return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? {} : { problems: [t('connectionTypes.notWebAddress')] };
    } catch {
      return { problems: [t('connectionTypes.notWebAddress')] };
    }
  },
};

/** An OPDS catalog on a server, browsed and searched, with books downloaded into the library from it; nothing is sent there. */
export const opdsServer: FeedType = {
  access: 'feed',
  id: 'opds.server',
  label: t('connectionTypes.opds.server'),
  read: true,
  formats: () => [],
  settings: [CATALOG_URL, SEARCH_TEMPLATE],
  url: (device) => String(device.settings?.url ?? '').trim(),
  searchTemplate: (device) => String(device.settings?.search ?? '').trim() || undefined,
};

/** Which formats of each book a served feed offers (`servedFormats` in `common/src/opdsServer.ts` reads it). */
const SERVED_FORMATS: SettingField = {
  key: 'formats',
  label: t('connectionTypes.formats'),
  kind: 'some',
  default: '',
  choices: (Object.keys(FORMATS) as FormatId[]).map((format) => ({ value: format, label: FORMATS[format].label })),
  noun: { one: t('connectionTypes.formatNoun.one'), many: t('connectionTypes.formatNoun.many') },
  help: t('connectionTypes.opds.formatsHelp'),
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
  label: t('connectionTypes.opds.served'),
  write: { single: false },
  formats: (device) => pickedChoices(device, SERVED_FORMATS) as FormatId[],
  settings: [SERVED_FORMATS],
  activation: async () => ((await serverSession())?.account ? undefined : t('connectionTypes.opds.signIn')),
};
