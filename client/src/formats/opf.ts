import { normalizeMetadata, type Creator, type MetadataValue } from '@nexlibris/common';
import { splitTags, titleFromFilename, type ParsedItem } from './formats';
import { parseXml } from './xml';

const DC_NS = 'http://purl.org/dc/elements/1.1/';
const OPF_NS = 'http://www.idpf.org/2007/opf';

/**
 * An OPF package document's metadata: an EPUB's, or the `metadata.opf` Calibre keeps beside
 * each book in its library folder.
 */
export interface OpfMetadata {
  parsed: Omit<ParsedItem, 'cover'>;
  /** The manifest id `<meta name="cover">` names, for finding an EPUB's cover. */
  coverId?: string;
  /** What Calibre records about the user's own copy, which only its library's `metadata.opf` is trusted for. */
  calibre: {
    /** 0–5, from Calibre's 0–10. */
    rating?: number;
    /** When the book was added to Calibre, as an ISO date. */
    added?: string;
  };
}

export function byLocalName(root: Document | Element, name: string): Element[] {
  return Array.from(root.getElementsByTagName('*')).filter((el) => el.localName === name);
}

/** Reads `metadata.opf` text; undefined if it isn't a package document with metadata. */
export function parseOpf(text: string, filename: string): OpfMetadata | undefined {
  const opf = parseXml(text);
  return opf && readOpf(opf, filename);
}

/** An OPF's metadata; undefined if it has no `<metadata>`. The title falls back to `filename`. */
export function readOpf(opf: Document, filename: string): OpfMetadata | undefined {
  const metadataEl = byLocalName(opf, 'metadata')[0];
  if (!metadataEl) return undefined;
  const refines = collectRefines(metadataEl);

  const dc = (name: string) => byLocalName(metadataEl, name).filter((el) => el.namespaceURI === DC_NS);
  const text = (el: Element | undefined) => el?.textContent?.trim() || undefined;

  const titles = dc('title');
  const mainTitle = titles.find((el) => refines(el, 'title-type') === 'main') ?? titles[0];
  const title = text(mainTitle) ?? titleFromFilename(filename);
  const subtitle = titles.find((el) => refines(el, 'title-type') === 'subtitle');
  /** An element's `file-as`: EPUB 2's attribute, or EPUB 3's refinement. */
  const fileAs = (el: Element | undefined) =>
    el && (el.getAttributeNS(OPF_NS, 'file-as') || el.getAttribute('opf:file-as') || refines(el, 'file-as'))?.trim();

  const creatorEls = dc('creator').filter((el) => text(el));
  const roleOf = (el: Element) => el.getAttributeNS(OPF_NS, 'role') ?? el.getAttribute('opf:role') ?? refines(el, 'role') ?? 'aut';
  const creators = creatorEls.map((el): Creator => ({ name: text(el)!, role: roleOf(el) }));
  // The authors' sort names where the file gives them, joined as Calibre joins them.
  const authorEls = creatorEls.filter((el) => roleOf(el) === 'aut');
  const authorSorts = authorEls.map(fileAs);
  const authorSort = authorSorts.length && authorSorts.every(Boolean) ? (authorSorts as string[]).join(' & ') : undefined;

  const identifiers: Record<string, string> = {};
  for (const el of dc('identifier')) {
    const value = text(el);
    if (!value) continue;
    const scheme = el.getAttributeNS(OPF_NS, 'scheme') ?? el.getAttribute('opf:scheme') ?? refines(el, 'identifier-type');
    const [key, normalized] = classifyIdentifier(value, scheme);
    // A Calibre library's own number for the book means nothing outside it; its UUID is kept.
    if (key === 'calibre') continue;
    identifiers[key] ??= normalized;
  }

  const metadata: Record<string, MetadataValue> = {};
  const setIfPresent = (key: string, value: MetadataValue | undefined) => {
    if (value !== undefined && value !== '') metadata[key] = value;
  };
  const metas = byLocalName(metadataEl, 'meta');
  const namedMeta = (name: string) => metas.find((m) => m.getAttribute('name') === name)?.getAttribute('content') ?? undefined;

  setIfPresent('subtitle', text(subtitle));
  setIfPresent('titleSort', namedMeta('calibre:title_sort')?.trim() || fileAs(mainTitle));
  setIfPresent('authorSort', authorSort);
  setIfPresent('language', text(dc('language')[0]));
  setIfPresent('publisher', text(dc('publisher')[0]));
  setIfPresent('rights', text(dc('rights')[0]));
  // EPUB 2 can say which date is which (`opf:event`); an undescribed one is the publication date.
  const event = (el: Element) => (el.getAttributeNS(OPF_NS, 'event') ?? el.getAttribute('opf:event') ?? '').toLowerCase();
  const dates = dc('date');
  setIfPresent('published', text(dates.find((el) => event(el) === 'publication') ?? dates.find((el) => !event(el))));
  setIfPresent('originallyPublished', text(dates.find((el) => event(el) === 'original-publication')));
  setIfPresent('description', text(dc('description')[0]));
  const collection = metas.find(
    (m) => m.getAttribute('property') === 'belongs-to-collection' && refines(m, 'collection-type') !== 'set',
  );
  setIfPresent('series', namedMeta('calibre:series') ?? text(collection));
  const seriesIndex = namedMeta('calibre:series_index') ?? (collection && refines(collection, 'group-position'));
  if (seriesIndex && !Number.isNaN(Number(seriesIndex))) metadata.seriesIndex = Number(seriesIndex);

  const tags = splitTags(dc('subject').map(text).filter((s): s is string => !!s));

  const calibre: OpfMetadata['calibre'] = {};
  const rating = Number(namedMeta('calibre:rating'));
  // Calibre rates 0–10 in half stars; 0 is unrated.
  if (rating > 0 && rating <= 10) calibre.rating = rating / 2;
  const added = new Date(namedMeta('calibre:timestamp') ?? '');
  if (!Number.isNaN(added.getTime()) && added.getUTCFullYear() > 1000) calibre.added = added.toISOString();

  const coverId = namedMeta('cover');
  return { parsed: { title, creators, identifiers, tags, metadata: normalizeMetadata(metadata) }, ...(coverId && { coverId }), calibre };
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
