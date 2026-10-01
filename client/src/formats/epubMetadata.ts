import JSZip from 'jszip';
import type { EpubBook } from './epubBuilder';
import { parseXml } from './xml';

/** The metadata {@link writeEpubMetadata} writes, as conversions build it from an item (`bookFromItem`). */
export type EpubMetadata = Omit<EpubBook, 'chapters' | 'cover' | 'resources' | 'toc' | 'identifiers'>;

const DC_NS = 'http://purl.org/dc/elements/1.1/';
const OPF_NS = 'http://www.idpf.org/2007/opf';

/** Dublin Core elements replaced wholesale. Identifiers stay: the package's unique-identifier points at one. */
const REPLACED_DC = ['title', 'creator', 'contributor', 'subject', 'description', 'publisher', 'date'];
/** `<meta name>`s replaced (EPUB 2 / Calibre). */
const REPLACED_NAMES = ['calibre:series', 'calibre:series_index', 'calibre:title_sort', 'calibre:author_link_map'];

/**
 * Rewrites an EPUB's package metadata from the library's, so a copy sent to a
 * device shows the user's edits. Everything else in the book, including its
 * identifiers and cover, is kept.
 */
export async function writeEpubMetadata(data: Blob, book: EpubMetadata): Promise<Blob> {
  const zip = await JSZip.loadAsync(await data.arrayBuffer());
  const containerText = await zip.file('META-INF/container.xml')?.async('string');
  const container = containerText ? parseXml(containerText) : undefined;
  const opfPath = container && Array.from(container.getElementsByTagName('*')).find((el) => el.localName === 'rootfile')?.getAttribute('full-path');
  const opfText = opfPath && (await zip.file(opfPath)?.async('string'));
  const opf = opfText ? parseXml(opfText) : undefined;
  const metadata = opf && Array.from(opf.getElementsByTagName('*')).find((el) => el.localName === 'metadata');
  if (!opfPath || !opf || !metadata) throw new Error('The EPUB has no readable package document.');

  const epub3 = (opf.documentElement.getAttribute('version') ?? '2').startsWith('3');
  const children = Array.from(metadata.children);
  const removedIds = new Set<string>();
  for (const el of children) {
    const replaced =
      (el.namespaceURI === DC_NS && REPLACED_DC.includes(el.localName)) ||
      (el.namespaceURI === DC_NS && el.localName === 'language' && !!book.language) ||
      (el.localName === 'meta' && REPLACED_NAMES.includes(el.getAttribute('name') ?? '')) ||
      (el.localName === 'meta' && el.getAttribute('property') === 'belongs-to-collection');
    if (!replaced) continue;
    if (el.id) removedIds.add(`#${el.id}`);
    el.remove();
  }
  // What refined the removed elements (roles, file-as, series positions) goes with them.
  for (const el of children) {
    if (el.localName === 'meta' && removedIds.has(el.getAttribute('refines') ?? '')) el.remove();
  }

  const prefix = children.find((el) => el.namespaceURI === DC_NS)?.prefix ?? 'dc';
  const add = (el: Element) => metadata.appendChild(el);
  const dc = (name: string, text: string) => {
    const el = opf.createElementNS(DC_NS, `${prefix}:${name}`);
    el.textContent = text;
    return add(el);
  };
  const meta = (attributes: Record<string, string>, text?: string) => {
    const el = opf.createElementNS(metadata.namespaceURI ?? OPF_NS, 'meta');
    for (const [key, value] of Object.entries(attributes)) el.setAttribute(key, value);
    if (text !== undefined) el.textContent = text;
    return add(el);
  };

  dc('title', book.title);
  book.creators.forEach((creator, i) => {
    const el = dc('creator', creator.name);
    if (epub3) {
      el.id = `nexlibris-creator${i}`;
      meta({ refines: `#${el.id}`, property: 'role', scheme: 'marc:relators' }, creator.role);
    } else {
      el.setAttributeNS(OPF_NS, 'opf:role', creator.role);
    }
  });
  if (book.language) dc('language', book.language);
  for (const tag of book.tags ?? []) dc('subject', tag);
  if (book.description) dc('description', book.description);
  if (book.publisher) dc('publisher', book.publisher);
  if (book.published) dc('date', book.published);
  if (book.series) {
    meta({ name: 'calibre:series', content: book.series });
    if (book.seriesIndex !== undefined) meta({ name: 'calibre:series_index', content: String(book.seriesIndex) });
    if (epub3) {
      meta({ property: 'belongs-to-collection', id: 'nexlibris-series' }, book.series);
      meta({ refines: '#nexlibris-series', property: 'collection-type' }, 'series');
      if (book.seriesIndex !== undefined) {
        meta({ refines: '#nexlibris-series', property: 'group-position' }, String(book.seriesIndex));
      }
    }
  }

  zip.file(opfPath, `<?xml version="1.0" encoding="UTF-8"?>\n${new XMLSerializer().serializeToString(opf.documentElement)}`);
  // The mimetype entry must stay first and uncompressed; JSZip keeps the order it loaded.
  zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' });
  return zip.generateAsync({ type: 'blob', mimeType: 'application/epub+zip', compression: 'DEFLATE' });
}
