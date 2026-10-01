import type { Creator, MetadataValue } from '@nexlibris/common';
import JSZip from 'jszip';
import { splitTags, titleFromFilename, type ParsedItem } from './formats';
import { parseXml } from './xml';

export class EpubError extends Error {
  name = 'EpubError';
}

/** Extracts library metadata and the cover image from an EPUB's OPF. */
export async function parseEpub(data: Blob, filename = 'Untitled.epub'): Promise<ParsedItem> {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(await data.arrayBuffer());
  } catch {
    throw new EpubError(`${filename} is not a valid EPUB (not a zip archive)`);
  }

  const container = await readXml(zip, 'META-INF/container.xml');
  const opfPath = container && byLocalName(container, 'rootfile')[0]?.getAttribute('full-path');
  const opf = opfPath ? await readXml(zip, opfPath) : undefined;
  if (!opfPath || !opf) throw new EpubError(`${filename} has no readable package document`);

  const metadataEl = byLocalName(opf, 'metadata')[0];
  if (!metadataEl) throw new EpubError(`${filename} has no <metadata> element`);
  const refines = collectRefines(metadataEl);

  const dc = (name: string) => byLocalName(metadataEl, name).filter((el) => el.namespaceURI === DC_NS);
  const text = (el: Element | undefined) => el?.textContent?.trim() || undefined;

  const titles = dc('title');
  const mainTitle = titles.find((el) => refines(el, 'title-type') === 'main') ?? titles[0];
  const title = text(mainTitle) ?? titleFromFilename(filename);

  const creators = dc('creator').flatMap((el): Creator[] => {
    const name = text(el);
    if (!name) return [];
    return [{ name, role: el.getAttributeNS(OPF_NS, 'role') ?? el.getAttribute('opf:role') ?? refines(el, 'role') ?? 'aut' }];
  });

  const identifiers: Record<string, string> = {};
  for (const el of dc('identifier')) {
    const value = text(el);
    if (!value) continue;
    const scheme = el.getAttributeNS(OPF_NS, 'scheme') ?? el.getAttribute('opf:scheme') ?? refines(el, 'identifier-type');
    const [key, normalized] = classifyIdentifier(value, scheme);
    identifiers[key] ??= normalized;
  }

  const metadata: Record<string, MetadataValue> = {};
  const setIfPresent = (key: string, value: MetadataValue | undefined) => {
    if (value !== undefined && value !== '') metadata[key] = value;
  };
  setIfPresent('language', text(dc('language')[0]));
  setIfPresent('publisher', text(dc('publisher')[0]));
  setIfPresent('published', text(dc('date')[0]));
  setIfPresent('description', text(dc('description')[0]));

  const metas = byLocalName(metadataEl, 'meta');
  const namedMeta = (name: string) => metas.find((m) => m.getAttribute('name') === name)?.getAttribute('content') ?? undefined;
  const collection = metas.find(
    (m) => m.getAttribute('property') === 'belongs-to-collection' && refines(m, 'collection-type') !== 'set',
  );
  setIfPresent('series', namedMeta('calibre:series') ?? text(collection));
  const seriesIndex = namedMeta('calibre:series_index') ?? (collection && refines(collection, 'group-position'));
  if (seriesIndex && !Number.isNaN(Number(seriesIndex))) metadata.seriesIndex = Number(seriesIndex);

  const cover = await readCover(zip, opf, opfPath, namedMeta('cover'));
  const tags = splitTags(dc('subject').map(text).filter((s): s is string => !!s));
  return { title, creators, identifiers, tags, metadata, ...(cover && { cover }) };
}

const DC_NS = 'http://purl.org/dc/elements/1.1/';
const OPF_NS = 'http://www.idpf.org/2007/opf';

function byLocalName(root: Document | Element, name: string): Element[] {
  return Array.from(root.getElementsByTagName('*')).filter((el) => el.localName === name);
}

async function readXml(zip: JSZip, path: string): Promise<Document | undefined> {
  const file = zip.file(path);
  if (!file) return undefined;
  return parseXml(await file.async('string'));
}

/** EPUB 3 attaches properties to elements via `<meta refines="#id" property="…">`. */
function collectRefines(metadataEl: Element) {
  const byId = new Map<string, Map<string, string>>();
  for (const meta of byLocalName(metadataEl, 'meta')) {
    const target = meta.getAttribute('refines');
    const property = meta.getAttribute('property');
    const value = meta.textContent?.trim();
    if (!target?.startsWith('#') || !property || !value) continue;
    const props = byId.get(target.slice(1)) ?? new Map<string, string>();
    if (!props.has(property)) props.set(property, value);
    byId.set(target.slice(1), props);
  }
  return (el: Element, property: string) => {
    const id = el.getAttribute('id');
    return (id && byId.get(id)?.get(property)) || undefined;
  };
}

function classifyIdentifier(value: string, scheme: string | undefined): [string, string] {
  const lowerScheme = scheme?.toLowerCase();
  const stripped = value.replace(/^urn:/i, '');
  const prefix = /^(isbn|uuid|doi|asin):(.+)$/i.exec(stripped);
  if (prefix) return [prefix[1]!.toLowerCase(), prefix[2]!.trim()];
  const digits = value.replace(/[-\s]/g, '');
  if (lowerScheme === 'isbn' || (!lowerScheme && /^(97[89])?\d{9}[\dX]$/i.test(digits))) return ['isbn', digits];
  // EPUB 3 `identifier-type` uses ONIX code list 5, where 15 is ISBN-13.
  if (lowerScheme) return [lowerScheme === '15' ? 'isbn' : lowerScheme, value];
  return ['identifier', value];
}

async function readCover(zip: JSZip, opf: Document, opfPath: string, coverMetaId: string | undefined) {
  const items = byLocalName(opf, 'item');
  const isImage = (el: Element) => el.getAttribute('media-type')?.startsWith('image/') ?? false;
  const coverItem =
    items.find((el) => el.getAttribute('properties')?.split(/\s+/).includes('cover-image')) ??
    (coverMetaId ? items.find((el) => el.getAttribute('id') === coverMetaId && isImage(el)) : undefined) ??
    items.find((el) => isImage(el) && /cover/i.test(`${el.getAttribute('id')} ${el.getAttribute('href')}`));
  const href = coverItem?.getAttribute('href');
  if (!coverItem || !href) return undefined;

  const opfDir = opfPath.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/') + 1) : '';
  const path = resolvePath(opfDir, decodeURIComponent(href));
  const file = zip.file(path);
  if (!file) return undefined;
  const mediaType = coverItem.getAttribute('media-type') ?? 'image/jpeg';
  return { data: new Blob([await file.async('blob')], { type: mediaType }), mediaType };
}

function resolvePath(base: string, href: string): string {
  const parts: string[] = [];
  for (const segment of (base + href).split('/')) {
    if (segment === '..') parts.pop();
    else if (segment && segment !== '.') parts.push(segment);
  }
  return parts.join('/');
}
