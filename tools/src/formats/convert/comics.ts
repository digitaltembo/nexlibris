import JSZip from 'jszip';
import { openComic, type ComicOptions } from '../comic';
import { buildEpub, escapeXml, extensionFor } from '../epubBuilder';
import { writeRar, type RarEntry } from '../rar';
import { bookFromItem, type ConvertContext } from './bookFromItem';

/** Repackages a CBR's pages (and ComicInfo.xml) as a CBZ. Images are stored, not recompressed. */
export async function cbrToCbz(data: Blob, _ctx: ConvertContext, options: ComicOptions = {}): Promise<Blob> {
  const comic = await openComic('cbr', data, options);
  const zip = new JSZip();
  for (const page of comic.pages) zip.file(page.name.replace(/\\/g, '/'), await page.load(), { compression: 'STORE' });
  if (comic.comicInfo) zip.file('ComicInfo.xml', comic.comicInfo);
  return zip.generateAsync({ type: 'blob', mimeType: 'application/vnd.comicbook+zip' });
}

/** Repackages a CBZ's pages (and ComicInfo.xml) as a CBR, stored as RAR stores files uncompressed (`rar.ts`). */
export async function cbzToCbr(data: Blob, _ctx: ConvertContext): Promise<Blob> {
  const comic = await openComic('cbz', data);
  const entries: RarEntry[] = [];
  for (const page of comic.pages) entries.push({ name: page.name, data: new Uint8Array(await (await page.load()).arrayBuffer()) });
  if (comic.comicInfo) entries.push({ name: 'ComicInfo.xml', data: new TextEncoder().encode(comic.comicInfo) });
  return writeRar(entries);
}

/** An image-per-page EPUB from a comic, for EPUB-only readers. */
export async function comicToEpub(
  format: 'cbz' | 'cbr',
  data: Blob,
  ctx: ConvertContext,
  options: ComicOptions = {},
): Promise<Blob> {
  const comic = await openComic(format, data, options);
  const pages = await Promise.all(
    comic.pages.map(async (page, i) => ({
      path: `images/p${String(i + 1).padStart(4, '0')}.${extensionFor(page.mediaType)}`,
      mediaType: page.mediaType,
      data: await page.load(),
    })),
  );
  return buildEpub({
    ...bookFromItem(ctx),
    resources: [
      ...pages,
      {
        path: 'styles/comic.css',
        mediaType: 'text/css',
        data: 'body{margin:0;text-align:center}img{max-width:100%;max-height:100vh;object-fit:contain}',
      },
    ],
    chapters: pages.map((page, i) => ({
      id: `p${i + 1}`,
      title: `Page ${i + 1}`,
      body: `<div><img src="../${escapeXml(page.path)}" alt="Page ${i + 1}"/></div>`,
      stylesheets: ['styles/comic.css'],
    })),
    toc: [{ label: ctx.item.title, href: 'text/p1.xhtml' }],
  });
}
