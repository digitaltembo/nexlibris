import type { Creator } from '../metadata';
import JSZip from 'jszip';

export interface EpubChapter {
  /** Used for the chapter's filename, `text/<id>.xhtml`. */
  id: string;
  title: string;
  /** Well-formed XHTML for the inside of `<body>`. */
  body: string;
  /** Stylesheet paths relative to `OEBPS/`. */
  stylesheets?: string[];
}

export interface EpubResource {
  /** Relative to `OEBPS/`, e.g. `images/1.png`. */
  path: string;
  mediaType: string;
  data: Blob | Uint8Array<ArrayBuffer> | string;
}

export interface EpubTocEntry {
  label: string;
  /** Relative to `OEBPS/`, e.g. `text/c1.xhtml#start`. */
  href: string;
  children?: EpubTocEntry[];
}

export interface EpubBook {
  title: string;
  creators: Creator[];
  language?: string;
  identifiers?: Record<string, string>;
  tags?: string[];
  description?: string;
  publisher?: string;
  published?: string;
  series?: string;
  seriesIndex?: number;
  /** Sort names, written only into existing EPUBs (`writeEpubMetadata`); `authorSort` joined with ` & `, as Calibre does. */
  titleSort?: string;
  authorSort?: string;
  chapters: EpubChapter[];
  resources?: EpubResource[];
  /** Defaults to one entry per chapter. */
  toc?: EpubTocEntry[];
  cover?: { data: Blob; mediaType: string };
}

export function escapeXml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]!);
}

const IMAGE_EXTENSIONS: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
};

export function extensionFor(mediaType: string): string {
  return IMAGE_EXTENSIONS[mediaType] ?? mediaType.split('/').pop()?.replace(/[^a-z0-9]/gi, '') ?? 'bin';
}

/**
 * Serializes HTML (which may be sloppy, as MOBI and RTF output is) into
 * well-formed XHTML for an EPUB chapter body.
 */
export function htmlToXhtml(html: string): string {
  const doc = new DOMParser().parseFromString(`<!doctype html><html><body>${html}</body></html>`, 'text/html');
  const serializer = new XMLSerializer();
  return Array.from(doc.body.childNodes, (node) => serializer.serializeToString(node))
    .join('')
    .replace(/ xmlns="http:\/\/www\.w3\.org\/1999\/xhtml"/g, '');
}

function chapterDocument(chapter: EpubChapter, language: string): string {
  const links = (chapter.stylesheets ?? [])
    .map((href) => `<link rel="stylesheet" type="text/css" href="../${escapeXml(href)}"/>`)
    .join('');
  return `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="${escapeXml(language)}" lang="${escapeXml(language)}">
<head><meta charset="utf-8"/><title>${escapeXml(chapter.title)}</title>${links}</head>
<body>${chapter.body}</body>
</html>`;
}

function navList(entries: EpubTocEntry[], prefix: string): string {
  return `<ol>${entries
    .map(
      (e) =>
        `<li><a href="${escapeXml(prefix + e.href)}">${escapeXml(e.label)}</a>${e.children?.length ? navList(e.children, prefix) : ''}</li>`,
    )
    .join('')}</ol>`;
}

function ncxPoints(entries: EpubTocEntry[], counter: { n: number }): string {
  return entries
    .map((e) => {
      const n = ++counter.n;
      return `<navPoint id="np${n}" playOrder="${n}"><navLabel><text>${escapeXml(e.label)}</text></navLabel><content src="${escapeXml(e.href)}"/>${ncxPoints(e.children ?? [], counter)}</navPoint>`;
    })
    .join('');
}

/** Packages chapters and resources as an EPUB 3 file, with an NCX for EPUB 2 readers. */
export async function buildEpub(book: EpubBook): Promise<Blob> {
  const language = book.language || 'en';
  const identifiers = book.identifiers ?? {};
  const uid = identifiers.isbn
    ? `urn:isbn:${identifiers.isbn}`
    : identifiers.uuid
      ? `urn:uuid:${identifiers.uuid}`
      : `urn:uuid:${crypto.randomUUID()}`;
  const modified = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  const toc = book.toc ?? book.chapters.map((c) => ({ label: c.title, href: `text/${c.id}.xhtml` }));
  const resources = [...(book.resources ?? [])];
  let coverPath: string | undefined;
  if (book.cover) {
    coverPath = `images/cover.${extensionFor(book.cover.mediaType)}`;
    resources.push({ path: coverPath, mediaType: book.cover.mediaType, data: book.cover.data });
  }

  const zip = new JSZip();
  zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' });
  zip.file(
    'META-INF/container.xml',
    `<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`,
  );

  const meta: string[] = [
    `<dc:identifier id="uid">${escapeXml(uid)}</dc:identifier>`,
    `<dc:title>${escapeXml(book.title)}</dc:title>`,
    `<dc:language>${escapeXml(language)}</dc:language>`,
    `<meta property="dcterms:modified">${modified}</meta>`,
  ];
  book.creators.forEach((c, i) => {
    meta.push(
      `<dc:creator id="creator${i}">${escapeXml(c.name)}</dc:creator>`,
      `<meta refines="#creator${i}" property="role" scheme="marc:relators">${escapeXml(c.role)}</meta>`,
    );
  });
  for (const [scheme, value] of Object.entries(identifiers)) {
    if (`urn:${scheme}:${value}` !== uid) meta.push(`<dc:identifier>${escapeXml(`urn:${scheme}:${value}`)}</dc:identifier>`);
  }
  for (const tag of book.tags ?? []) meta.push(`<dc:subject>${escapeXml(tag)}</dc:subject>`);
  if (book.description) meta.push(`<dc:description>${escapeXml(book.description)}</dc:description>`);
  if (book.publisher) meta.push(`<dc:publisher>${escapeXml(book.publisher)}</dc:publisher>`);
  if (book.published) meta.push(`<dc:date>${escapeXml(book.published)}</dc:date>`);
  if (book.series) {
    meta.push(
      `<meta property="belongs-to-collection" id="series">${escapeXml(book.series)}</meta>`,
      `<meta refines="#series" property="collection-type">series</meta>`,
      `<meta name="calibre:series" content="${escapeXml(book.series)}"/>`,
    );
    if (book.seriesIndex !== undefined) {
      meta.push(
        `<meta refines="#series" property="group-position">${book.seriesIndex}</meta>`,
        `<meta name="calibre:series_index" content="${book.seriesIndex}"/>`,
      );
    }
  }
  if (coverPath) meta.push(`<meta name="cover" content="cover-image"/>`);

  const manifest: string[] = [
    `<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>`,
    `<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>`,
  ];
  resources.forEach((r, i) => {
    const id = r.path === coverPath ? 'cover-image' : `res${i}`;
    const props = r.path === coverPath ? ' properties="cover-image"' : '';
    manifest.push(`<item id="${id}" href="${escapeXml(r.path)}" media-type="${escapeXml(r.mediaType)}"${props}/>`);
    zip.file(`OEBPS/${r.path}`, r.data);
  });
  for (const chapter of book.chapters) {
    manifest.push(`<item id="ch-${escapeXml(chapter.id)}" href="text/${escapeXml(chapter.id)}.xhtml" media-type="application/xhtml+xml"/>`);
    zip.file(`OEBPS/text/${chapter.id}.xhtml`, chapterDocument(chapter, language));
  }
  const spine = book.chapters.map((c) => `<itemref idref="ch-${escapeXml(c.id)}"/>`).join('');

  zip.file(
    'OEBPS/content.opf',
    `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid">
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">${meta.join('')}</metadata>
<manifest>${manifest.join('')}</manifest>
<spine toc="ncx">${spine}</spine>
</package>`,
  );
  zip.file(
    'OEBPS/nav.xhtml',
    `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><meta charset="utf-8"/><title>${escapeXml(book.title)}</title></head>
<body><nav epub:type="toc" id="toc"><h1>Contents</h1>${navList(toc, '')}</nav></body></html>`,
  );
  zip.file(
    'OEBPS/toc.ncx',
    `<?xml version="1.0" encoding="utf-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1"><head><meta name="dtb:uid" content="${escapeXml(uid)}"/></head>
<docTitle><text>${escapeXml(book.title)}</text></docTitle><navMap>${ncxPoints(toc, { n: 0 })}</navMap></ncx>`,
  );

  return zip.generateAsync({ type: 'blob', mimeType: 'application/epub+zip', compression: 'DEFLATE' });
}
