import JSZip from 'jszip';
import { EpubError, epubDrm } from '../epub';
import { byLocalName } from '../opf';
import { parseXml } from '../xml';

/** An EPUB as a Kindle writer reads it: its files, reading order, table of contents and landmarks. */

export interface ManifestItem {
  id: string;
  /** Its path in the zip. */
  path: string;
  mediaType: string;
  properties: string[];
}

export interface TocNode {
  label: string;
  /** The file it points into, and where in it. */
  path: string;
  fragment?: string;
  children: TocNode[];
}

/** A landmark (EPUB 2's guide): `type` as the guide names them (`text`, `toc`, `cover`). */
export interface Landmark {
  type: string;
  title: string;
  path: string;
  fragment?: string;
}

export interface EpubPackage {
  manifest: ManifestItem[];
  byPath: Map<string, ManifestItem>;
  /** The reading order, linear items first, as Kindles have no non-linear items. */
  spine: ManifestItem[];
  toc: TocNode[];
  landmarks: Landmark[];
  /** The cover image's path, as the package names it. */
  cover?: string;
  /** `rtl` for books read right to left. */
  direction?: string;
  read(path: string): Promise<Uint8Array<ArrayBuffer> | undefined>;
  text(path: string): Promise<string | undefined>;
  /** A content document parsed: as XHTML, else as HTML where it isn't well-formed. */
  document(path: string): Promise<Document | undefined>;
  /** Fonts obfuscated by their publisher (not DRM), with the algorithm. */
  obfuscated: Map<string, string>;
  /** The package's unique identifier, which keys font obfuscation. */
  identifier?: string;
}

export const DOCUMENT_TYPES = new Set(['application/xhtml+xml', 'text/html', 'application/x-dtbook+xml']);

/** A path in the zip from an href in the file at `from`: relative to its folder, without the fragment, URL-decoded. */
export function resolveHref(from: string, href: string): string {
  const parts = from.split('/').slice(0, -1);
  let path = href.split('#')[0]!.split('?')[0]!;
  try {
    path = decodeURIComponent(path);
  } catch {
    // Not encoded after all.
  }
  if (path.startsWith('/')) parts.length = 0;
  for (const part of path.split('/')) {
    if (part === '..') parts.pop();
    else if (part && part !== '.') parts.push(part);
  }
  return parts.join('/');
}

/** An href's fragment, decoded. */
export function fragmentOf(href: string): string | undefined {
  const at = href.indexOf('#');
  if (at < 0 || at === href.length - 1) return undefined;
  try {
    return decodeURIComponent(href.slice(at + 1));
  } catch {
    return href.slice(at + 1);
  }
}

/** Whether an href leaves the book (`https:`, `mailto:` and so on). */
export const isExternal = (href: string) => /^[a-z][a-z0-9+.-]*:/i.test(href.trim());

const text = (el: Element | undefined) => el?.textContent?.replace(/\s+/g, ' ').trim() ?? '';

/** EPUB 3's `epub:type`, whatever prefix the document gives its namespace. */
const epubType = (el: Element) =>
  el.getAttributeNS('http://www.idpf.org/2007/ops', 'type') ?? el.getAttribute('epub:type') ?? '';

/** EPUB 3 landmarks as EPUB 2's guide types, which Kindles read. */
const LANDMARK_TYPES: Record<string, string> = { bodymatter: 'text', toc: 'toc', cover: 'cover', titlepage: 'title-page' };

export async function readEpubPackage(data: Blob): Promise<EpubPackage> {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(await data.arrayBuffer());
  } catch {
    throw new EpubError('This EPUB isn’t a valid zip archive.');
  }
  const drm = await epubDrm(data);
  if (drm) throw new EpubError(`This EPUB is protected (${drm}), so it can’t be converted.`);

  const read = async (path: string) => {
    const file = zip.file(path) ?? zip.file(new RegExp(`^${path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i'))[0];
    return file ? new Uint8Array(await file.async('uint8array')) : undefined;
  };
  const textOf = async (path: string) => {
    const bytes = await read(path);
    return bytes && new TextDecoder().decode(bytes);
  };
  const xml = async (path: string) => {
    const source = await textOf(path);
    return source === undefined ? undefined : parseXml(source);
  };

  const container = await xml('META-INF/container.xml');
  const opfPath = container && byLocalName(container, 'rootfile')[0]?.getAttribute('full-path');
  const opf = opfPath ? await xml(opfPath) : undefined;
  if (!opfPath || !opf) throw new EpubError('This EPUB has no readable package document.');

  const manifest: ManifestItem[] = byLocalName(opf, 'item').flatMap((el) => {
    const id = el.getAttribute('id');
    const href = el.getAttribute('href');
    if (!id || !href) return [];
    return [
      {
        id,
        path: resolveHref(opfPath, href),
        mediaType: (el.getAttribute('media-type') ?? '').toLowerCase(),
        properties: (el.getAttribute('properties') ?? '').split(/\s+/).filter(Boolean),
      },
    ];
  });
  const byId = new Map(manifest.map((item) => [item.id, item]));
  const byPath = new Map(manifest.map((item) => [item.path, item]));

  const spineEl = byLocalName(opf, 'spine')[0];
  const refs = byLocalName(opf, 'itemref').flatMap((el) => {
    const item = byId.get(el.getAttribute('idref') ?? '');
    return item && DOCUMENT_TYPES.has(item.mediaType) ? [{ item, linear: el.getAttribute('linear') !== 'no' }] : [];
  });
  const spine = [...refs.filter((r) => r.linear), ...refs.filter((r) => !r.linear)].map((r) => r.item);
  if (!spine.length) throw new EpubError('This EPUB has nothing to read: its spine is empty.');

  const coverMeta = byLocalName(opf, 'meta').find((el) => el.getAttribute('name') === 'cover')?.getAttribute('content');
  const coverItem =
    manifest.find((item) => item.properties.includes('cover-image')) ??
    (coverMeta ? (byId.get(coverMeta) ?? byPath.get(resolveHref(opfPath, coverMeta))) : undefined);

  const document = async (path: string) => {
    const source = await textOf(path);
    if (source === undefined) return undefined;
    return parseXml(source) ?? new DOMParser().parseFromString(source, 'text/html');
  };

  const toc = await readToc(manifest, spineEl?.getAttribute('toc') ?? undefined, byId, document, xml);
  const landmarks = await readLandmarks(opf, opfPath, manifest, document);

  const obfuscated = new Map<string, string>();
  const encryption = await xml('META-INF/encryption.xml');
  for (const data of encryption ? byLocalName(encryption, 'EncryptedData') : []) {
    const algorithm = byLocalName(data, 'EncryptionMethod')[0]?.getAttribute('Algorithm');
    const uri = byLocalName(data, 'CipherReference')[0]?.getAttribute('URI');
    if (algorithm && uri) obfuscated.set(resolveHref('', uri), algorithm);
  }
  const uidId = opf.documentElement.getAttribute('unique-identifier');
  const identifier = byLocalName(opf, 'identifier').find((el) => el.getAttribute('id') === uidId)?.textContent ?? undefined;

  return {
    manifest,
    byPath,
    spine,
    toc,
    landmarks,
    ...(coverItem?.mediaType.startsWith('image/') && { cover: coverItem.path }),
    ...(spineEl?.getAttribute('page-progression-direction') && { direction: spineEl.getAttribute('page-progression-direction')! }),
    read,
    text: textOf,
    document,
    obfuscated,
    ...(identifier && { identifier }),
  };
}

async function readToc(
  manifest: ManifestItem[],
  ncxId: string | undefined,
  byId: Map<string, ManifestItem>,
  document: (path: string) => Promise<Document | undefined>,
  xml: (path: string) => Promise<Document | undefined>,
): Promise<TocNode[]> {
  const nav = manifest.find((item) => item.properties.includes('nav'));
  const navDoc = nav && (await document(nav.path));
  const navs = navDoc ? byLocalName(navDoc, 'nav') : [];
  const tocNav = navs.find((el) => epubType(el).split(/\s+/).includes('toc')) ?? navs[0];
  if (nav && tocNav) {
    const list = (ol: Element | undefined): TocNode[] =>
      Array.from(ol?.children ?? [])
        .filter((li) => li.localName === 'li')
        .flatMap((li) => {
          const a = Array.from(li.children).find((c) => c.localName === 'a' || c.localName === 'span');
          const children = list(Array.from(li.children).find((c) => c.localName === 'ol' || c.localName === 'ul'));
          const href = a?.localName === 'a' ? a.getAttribute('href') : null;
          if (!href || isExternal(href)) return children;
          return [{ label: text(a) || 'Untitled', path: resolveHref(nav.path, href), ...fragmentPart(href), children }];
        });
    const toc = list(Array.from(tocNav.children).find((c) => c.localName === 'ol' || c.localName === 'ul'));
    if (toc.length) return toc;
  }

  const ncx = (ncxId && byId.get(ncxId)) || manifest.find((item) => item.mediaType === 'application/x-dtbncx+xml');
  const ncxDoc = ncx && (await xml(ncx.path));
  const navMap = ncxDoc && byLocalName(ncxDoc, 'navMap')[0];
  if (!ncx || !navMap) return [];
  const points = (parent: Element): TocNode[] =>
    Array.from(parent.children)
      .filter((el) => el.localName === 'navPoint')
      .flatMap((point) => {
        const label = Array.from(point.children).find((c) => c.localName === 'navLabel');
        const src = Array.from(point.children).find((c) => c.localName === 'content')?.getAttribute('src');
        const children = points(point);
        if (!src) return children;
        return [{ label: text(label) || 'Untitled', path: resolveHref(ncx.path, src), ...fragmentPart(src), children }];
      });
  return points(navMap);
}

const fragmentPart = (href: string) => {
  const fragment = fragmentOf(href);
  return fragment ? { fragment } : {};
};

async function readLandmarks(
  opf: Document,
  opfPath: string,
  manifest: ManifestItem[],
  document: (path: string) => Promise<Document | undefined>,
): Promise<Landmark[]> {
  const guide = byLocalName(opf, 'reference').flatMap((el) => {
    const type = el.getAttribute('type')?.toLowerCase();
    const href = el.getAttribute('href');
    if (!type || !href) return [];
    return [{ type, title: el.getAttribute('title') ?? type, path: resolveHref(opfPath, href), ...fragmentPart(href) }];
  });
  if (guide.length) return guide;
  const nav = manifest.find((item) => item.properties.includes('nav'));
  const navDoc = nav && (await document(nav.path));
  const landmarks = navDoc && byLocalName(navDoc, 'nav').find((el) => epubType(el).split(/\s+/).includes('landmarks'));
  if (!nav || !landmarks) return [];
  return byLocalName(landmarks, 'a').flatMap((a) => {
    const type = LANDMARK_TYPES[epubType(a).trim()];
    const href = a.getAttribute('href');
    return type && href ? [{ type, title: text(a) || type, path: resolveHref(nav.path, href), ...fragmentPart(href) }] : [];
  });
}
