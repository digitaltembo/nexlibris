import JSZip from 'jszip';
import type { ParsedItem } from './formats';
import { byLocalName, readOpf } from './opf';
import { parseXml } from './xml';

export class EpubError extends Error {
  name = 'EpubError';
}

/** Extracts library metadata and the cover image (unless `cover` is false) from an EPUB's OPF. */
export async function parseEpub(data: Blob, filename = 'Untitled.epub', options: { cover?: boolean } = {}): Promise<ParsedItem> {
  const zip = await openEpub(data, filename);

  const container = await readXml(zip, 'META-INF/container.xml');
  const opfPath = container && byLocalName(container, 'rootfile')[0]?.getAttribute('full-path');
  const opf = opfPath ? await readXml(zip, opfPath) : undefined;
  if (!opfPath || !opf) throw new EpubError(`${filename} has no readable package document`);

  const read = readOpf(opf, filename);
  if (!read) throw new EpubError(`${filename} has no <metadata> element`);
  const { parsed, coverId } = read;
  const cover = options.cover === false ? undefined : await readCover(zip, opf, opfPath, coverId);
  return { ...parsed, ...(cover && { cover }) };
}

async function openEpub(data: Blob, filename: string): Promise<JSZip> {
  try {
    return await JSZip.loadAsync(await data.arrayBuffer());
  } catch {
    throw new EpubError(`${filename} is not a valid EPUB (not a zip archive)`);
  }
}

/** Font obfuscation (IDPF's and Adobe's), which publishers use without DRM: the key is the book's identifier. */
const OBFUSCATION = ['http://www.idpf.org/2008/embedding', 'http://ns.adobe.com/pdf/enc#RC'];

/**
 * The DRM an EPUB carries (Adobe's, Apple's, Readium LCP, or any encryption beyond font obfuscation),
 * or undefined for one that has none. Such a book's metadata can still be read, but its file mustn't
 * be rewritten.
 */
export async function epubDrm(data: Blob, filename = 'Untitled.epub'): Promise<string | undefined> {
  const zip = await openEpub(data, filename);
  if (zip.file('META-INF/rights.xml')) return 'Adobe DRM';
  if (zip.file('META-INF/sinf.xml')) return 'Apple DRM';
  if (zip.file('META-INF/license.lcpl')) return 'Readium LCP';
  const encryption = await readXml(zip, 'META-INF/encryption.xml');
  const algorithms = encryption ? byLocalName(encryption, 'EncryptionMethod').map((el) => el.getAttribute('Algorithm') ?? '') : [];
  return algorithms.some((a) => !OBFUSCATION.includes(a)) ? 'encrypted' : undefined;
}

async function readXml(zip: JSZip, path: string): Promise<Document | undefined> {
  const file = zip.file(path);
  if (!file) return undefined;
  return parseXml(await file.async('string'));
}

/**
 * The manifest item of an EPUB's cover image: the one marked `cover-image` (EPUB 3), else the one its `<meta
 * name="cover">` names (EPUB 2), else an image named like a cover. `writeEpubMetadata` replaces the same one.
 */
export function coverManifestItem(opf: Document, coverMetaId?: string): Element | undefined {
  const items = byLocalName(opf, 'item');
  const isImage = (el: Element) => el.getAttribute('media-type')?.startsWith('image/') ?? false;
  const metaId = coverMetaId ?? byLocalName(opf, 'meta').find((el) => el.getAttribute('name') === 'cover')?.getAttribute('content') ?? undefined;
  return (
    items.find((el) => el.getAttribute('properties')?.split(/\s+/).includes('cover-image')) ??
    (metaId ? items.find((el) => el.getAttribute('id') === metaId && isImage(el)) : undefined) ??
    items.find((el) => isImage(el) && /cover/i.test(`${el.getAttribute('id')} ${el.getAttribute('href')}`))
  );
}

/** The folder of the package document, which its hrefs are relative to (`OEBPS/`, or `` at the root). */
export const opfFolder = (opfPath: string) => (opfPath.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/') + 1) : '');

async function readCover(zip: JSZip, opf: Document, opfPath: string, coverMetaId: string | undefined) {
  const coverItem = coverManifestItem(opf, coverMetaId);
  const href = coverItem?.getAttribute('href');
  if (!coverItem || !href) return undefined;

  const path = resolvePath(opfFolder(opfPath), decodeURIComponent(href));
  const file = zip.file(path);
  if (!file) return undefined;
  const mediaType = coverItem.getAttribute('media-type') ?? 'image/jpeg';
  return { data: new Blob([await file.async('blob')], { type: mediaType }), mediaType };
}

/** A path in the zip from a folder and an href relative to it. */
export function resolvePath(base: string, href: string): string {
  const parts: string[] = [];
  for (const segment of (base + href).split('/')) {
    if (segment === '..') parts.pop();
    else if (segment && segment !== '.') parts.push(segment);
  }
  return parts.join('/');
}
