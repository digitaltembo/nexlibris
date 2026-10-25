import JSZip from 'jszip';
import type { Creator } from '../metadata';
import { coverManifestItem, opfFolder, resolvePath } from './epub';
import { extensionFor, type EpubBook } from './epubBuilder';
import { splitTags, type ParsedItem } from './formats';
import { bcp47Language, sameLanguage } from './language';
import { parseXml } from './xml';

/** The metadata {@link writeEpubMetadata} writes, as conversions build it from an item (`bookFromItem`). */
export type EpubMetadata = Omit<EpubBook, 'chapters' | 'cover' | 'resources' | 'toc' | 'identifiers'>;

/** A cover image {@link writeEpubMetadata} puts in a book. */
export type EpubCover = NonNullable<EpubBook['cover']>;

const DC_NS = 'http://purl.org/dc/elements/1.1/';
const OPF_NS = 'http://www.idpf.org/2007/opf';

/** A date EPUB can hold (W3CDTF has no years before AD 1, which the library writes with a minus). */
const writableDate = (date: string | undefined) => (date && !date.startsWith('-') ? date : undefined);

/** The authors' sort names, one per author, when `authorSort` names as many as there are authors. */
function authorSorts(book: EpubMetadata): string[] | undefined {
  const authors = book.creators.filter((c) => c.role === 'aut').length;
  const sorts = book.authorSort?.split(' & ').map((s) => s.trim());
  return authors && sorts?.length === authors && sorts.every(Boolean) ? sorts : undefined;
}

/**
 * Rewrites an EPUB's package metadata from the library's, so a copy sent to a device, or the
 * library's own file (`library/updateFiles.ts`), shows the user's edits. What the library has
 * replaces what the file says; what it lacks (no description, say, or no tags) is left as the file
 * has it. With a `cover`, the book's cover image is replaced too (`writeCover`). Everything else in
 * the book, including its identifiers, is kept.
 */
export async function writeEpubMetadata(data: Blob, book: EpubMetadata, cover?: EpubCover): Promise<Blob> {
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
  const isDc = (el: Element, ...names: string[]) => el.namespaceURI === DC_NS && names.includes(el.localName);
  const named = (el: Element, ...names: string[]) => el.localName === 'meta' && names.includes(el.getAttribute('name') ?? '');
  const refined = (el: Element, property: string) =>
    el.id && children.find((m) => m.getAttribute('refines') === `#${el.id}` && m.getAttribute('property') === property)?.textContent?.trim();
  const event = (el: Element) => (el.getAttributeNS(OPF_NS, 'event') ?? el.getAttribute('opf:event') ?? '').toLowerCase();

  const published = writableDate(book.published);
  const sorts = book.creators.length ? authorSorts(book) : undefined;
  const oldLanguage = children.find((el) => isDc(el, 'language'))?.textContent?.trim();
  // A file that already says the language, in whatever form (`en-US` for the library's `eng`), keeps its own.
  const language = book.language && !(oldLanguage && sameLanguage(oldLanguage, book.language)) ? bcp47Language(book.language) : undefined;
  const oldTitle = children.find((el) => isDc(el, 'title'))?.textContent?.trim();
  // A sort title kept from the file must still be the title's.
  const titleSortGoes = !!book.titleSort || oldTitle !== book.title.trim();
  const replaced = (el: Element) =>
    isDc(el, 'title') ||
    (!!book.creators.length && (isDc(el, 'creator', 'contributor') || named(el, 'calibre:author_link_map'))) ||
    (!!language && isDc(el, 'language')) ||
    (!!book.tags?.length && isDc(el, 'subject')) ||
    (!!book.description && isDc(el, 'description')) ||
    (!!book.publisher && isDc(el, 'publisher')) ||
    // Only the publication date: an EPUB 2 book's other dates (original publication, say) stay.
    (!!published && isDc(el, 'date') && ['', 'publication'].includes(event(el))) ||
    (!!book.series &&
      (named(el, 'calibre:series', 'calibre:series_index') ||
        (el.getAttribute('property') === 'belongs-to-collection' && refined(el, 'collection-type') !== 'set'))) ||
    (titleSortGoes && named(el, 'calibre:title_sort'));
  const removedIds = new Set<string>();
  for (const el of children) {
    if (!replaced(el)) continue;
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
  let author = 0;
  book.creators.forEach((creator, i) => {
    const el = dc('creator', creator.name);
    const fileAs = creator.role === 'aut' ? sorts?.[author++] : undefined;
    if (epub3) {
      el.id = `nexlibris-creator${i}`;
      meta({ refines: `#${el.id}`, property: 'role', scheme: 'marc:relators' }, creator.role);
      if (fileAs) meta({ refines: `#${el.id}`, property: 'file-as' }, fileAs);
    } else {
      el.setAttributeNS(OPF_NS, 'opf:role', creator.role);
      if (fileAs) el.setAttributeNS(OPF_NS, 'opf:file-as', fileAs);
    }
  });
  if (language) dc('language', language);
  for (const tag of book.tags ?? []) dc('subject', tag);
  if (book.description) dc('description', book.description);
  if (book.publisher) dc('publisher', book.publisher);
  if (published) dc('date', published);
  if (book.titleSort) meta({ name: 'calibre:title_sort', content: book.titleSort });
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

  if (cover) await writeCover(zip, opf, opfPath, metadata, cover, epub3);

  // Some serializers (happy-dom's) write a non-breaking space as HTML's `&nbsp;`, which XML doesn't know.
  const xml = new XMLSerializer().serializeToString(opf.documentElement).replaceAll('&nbsp;', '&#160;');
  zip.file(opfPath, `<?xml version="1.0" encoding="UTF-8"?>\n${xml}`);
  // The mimetype entry must stay first and uncompressed; JSZip keeps the order it loaded.
  zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' });
  return zip.generateAsync({ type: 'blob', mimeType: 'application/epub+zip', compression: 'DEFLATE' });
}

/** Files that may refer to the cover image by name: pages, styles, the old table of contents. */
const REFERRING = /\.(x?html?|svg|css|ncx)$/i;

/**
 * Puts `cover` in the book as its cover image: in place of the image it has (the one `parseEpub` reads as its cover),
 * or as a new one where it has none, marked as the cover both ways (EPUB 3's `cover-image`, EPUB 2's `<meta
 * name="cover">`). An image of another type gets that type's extension, and the pages and styles naming the old file
 * name the new one. Readers show the image marked; a cover page the book has shows the new image too.
 */
async function writeCover(zip: JSZip, opf: Document, opfPath: string, metadata: Element, cover: EpubCover, epub3: boolean) {
  const manifest = Array.from(opf.getElementsByTagName('*')).find((el) => el.localName === 'manifest');
  if (!manifest) throw new Error('The EPUB has no manifest.');
  const folder = opfFolder(opfPath);
  const extension = extensionFor(cover.mediaType);
  const taken = (path: string) => !!zip.file(path);
  /** A file name in `dir` for `stem` with the cover's extension, not already used. */
  const freePath = (dir: string, stem: string) => {
    for (let i = 0; ; i++) {
      const name = `${stem}${i ? `-${i}` : ''}.${extension}`;
      if (!taken(resolvePath(folder, dir + name))) return dir + name;
    }
  };

  let item = coverManifestItem(opf);
  const oldHref = item?.getAttribute('href');
  if (item && oldHref) {
    const oldPath = resolvePath(folder, decodeURIComponent(oldHref));
    if (item.getAttribute('media-type') === cover.mediaType) zip.file(oldPath, cover.data);
    else {
      // Named for its type, so readers that go by the extension read it.
      const slash = oldHref.lastIndexOf('/') + 1;
      const dir = oldHref.slice(0, slash);
      const oldName = oldHref.slice(slash);
      const stem = decodeURIComponent(oldName).replace(/\.[^.]*$/, '');
      zip.remove(oldPath);
      const href = freePath(dir, stem);
      const newName = href.slice(slash);
      zip.file(resolvePath(folder, decodeURIComponent(href)), cover.data);
      item.setAttribute('href', href);
      item.setAttribute('media-type', cover.mediaType);
      for (const file of Object.values(zip.files)) {
        if (file.dir || !REFERRING.test(file.name)) continue;
        const text = await file.async('string');
        if (text.includes(oldName)) zip.file(file.name, text.replaceAll(oldName, newName));
      }
    }
  } else {
    const ids = new Set(Array.from(opf.getElementsByTagName('*'), (el) => el.getAttribute('id')));
    let id = 'nexlibris-cover';
    for (let i = 1; ids.has(id); i++) id = `nexlibris-cover-${i}`;
    const href = freePath('', 'cover');
    zip.file(resolvePath(folder, href), cover.data);
    item = opf.createElementNS(manifest.namespaceURI ?? OPF_NS, 'item');
    item.setAttribute('id', id);
    item.setAttribute('href', href);
    item.setAttribute('media-type', cover.mediaType);
    manifest.appendChild(item);
  }

  // Marked as the cover both ways, whichever way the book found it.
  if (epub3) {
    const properties = (item.getAttribute('properties') ?? '').split(/\s+/).filter(Boolean);
    if (!properties.includes('cover-image')) item.setAttribute('properties', [...properties, 'cover-image'].join(' '));
  }
  if (!item.id) item.setAttribute('id', 'nexlibris-cover');
  const named = Array.from(metadata.children).filter((el) => el.localName === 'meta' && el.getAttribute('name') === 'cover');
  for (const el of named) el.remove();
  const meta = opf.createElementNS(metadata.namespaceURI ?? OPF_NS, 'meta');
  meta.setAttribute('name', 'cover');
  meta.setAttribute('content', item.id);
  metadata.appendChild(meta);
}

/**
 * What `writeEpubMetadata` would change in a file whose metadata reads as `parsed`: the names of
 * the fields where the library's differ (only those it has and the writer writes), so files already
 * in step are left alone.
 */
export function epubMetadataChanges(parsed: ParsedItem, book: EpubMetadata): string[] {
  const changes: string[] = [];
  const text = (value: unknown) => (typeof value === 'string' ? value.trim() : value);
  const differs = (name: string, wanted: unknown, has: unknown) => {
    if (wanted !== undefined && wanted !== '' && text(wanted) !== text(has)) changes.push(name);
  };
  const { metadata } = parsed;
  differs('title', book.title, parsed.title);
  const creators = (list: Creator[]) => JSON.stringify(list.map((c) => [c.name.trim(), c.role]));
  if (book.creators.length) differs('creators', creators(book.creators), creators(parsed.creators));
  const tags = (list: readonly string[]) => JSON.stringify(splitTags(list).sort());
  if (book.tags?.length) differs('tags', tags(book.tags), tags(parsed.tags));
  if (book.language && !(metadata.language && sameLanguage(String(metadata.language), book.language))) changes.push('language');
  differs('description', book.description, metadata.description);
  differs('publisher', book.publisher, metadata.publisher);
  differs('published', writableDate(book.published), metadata.published);
  differs('series', book.series, metadata.series);
  if (book.series) differs('series index', book.seriesIndex, metadata.seriesIndex);
  differs('title sort', book.titleSort, metadata.titleSort);
  const sorts = book.creators.length ? authorSorts(book) : undefined;
  if (sorts) differs('author sort', sorts.join(' & '), metadata.authorSort);
  return changes;
}
