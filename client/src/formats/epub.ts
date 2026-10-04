import JSZip from 'jszip';
import type { ParsedItem } from './formats';
import { byLocalName, readOpf } from './opf';
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

  const read = readOpf(opf, filename);
  if (!read) throw new EpubError(`${filename} has no <metadata> element`);
  const { parsed, coverId } = read;
  const cover = await readCover(zip, opf, opfPath, coverId);
  return { ...parsed, ...(cover && { cover }) };
}

async function readXml(zip: JSZip, path: string): Promise<Document | undefined> {
  const file = zip.file(path);
  if (!file) return undefined;
  return parseXml(await file.async('string'));
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
