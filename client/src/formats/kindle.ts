import type { Kf8, Mobi } from '@lingo-reader/mobi-parser';
import { bookFromItem, type ConvertContext } from './convert/bookFromItem';
import { buildEpub, extensionFor, htmlToXhtml, type EpubChapter, type EpubResource, type EpubTocEntry } from './epubBuilder';
import { emptyParsedItem, splitTags, type ParsedItem } from './formats';
import { readKindleHeader, type KindleHeader } from './kindleHeader';

export class KindleError extends Error {
  name = 'KindleError';
}

type KindleBook = Mobi | Kf8;

/**
 * The most text, uncompressed, that's converted to EPUB in the app: 16 times a long novel. The
 * parser holds a book's text many times over and the conversion builds a DOM of all of it, so a
 * dictionary (tens to hundreds of megabytes) can take gigabytes. Bigger books stay as they are.
 */
export const MAX_CONVERT_TEXT = 16_000_000;

const megabytes = (bytes: number) => `${Math.round(bytes / 1e6)} MB`;

/** A Kindle file's headers, refusing one whose text can't be read (DRM). */
async function header(data: Blob): Promise<KindleHeader> {
  let header: KindleHeader;
  try {
    header = readKindleHeader(new Uint8Array(await data.arrayBuffer()));
  } catch (e) {
    throw new KindleError(`Not a readable MOBI/AZW file: ${e instanceof Error ? e.message : e}`);
  }
  if (header.encrypted) throw new KindleError('This book is DRM-protected, so its text can’t be read.');
  return header;
}

/** Reads a resource the parser exposes by URL: a blob URL in browsers, a file path under Node (tests). */
export type ResourceFetcher = (url: string) => Promise<{ data: Uint8Array<ArrayBuffer>; mediaType: string }>;

export interface KindleOptions {
  fetchResource?: ResourceFetcher;
  /** Where the Node build of the parser writes resources; unused in browsers. */
  resourceSaveDir?: string;
}

const MEDIA_TYPES: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  bmp: 'image/bmp',
  svg: 'image/svg+xml',
  css: 'text/css',
  ttf: 'font/ttf',
  otf: 'font/otf',
  woff: 'font/woff',
  woff2: 'font/woff2',
};

const fetchByUrl: ResourceFetcher = async (url) => {
  const response = await fetch(url);
  const blob = await response.blob();
  const ext = url.split('.').pop()?.toLowerCase() ?? '';
  return { data: new Uint8Array(await blob.arrayBuffer()), mediaType: blob.type || MEDIA_TYPES[ext] || 'application/octet-stream' };
};

/**
 * Opens a Kindle file. KF8 (AZW3, and the KF8 half of "joint" MOBIs) keeps the
 * publisher's HTML and CSS, so it's preferred; older MOBI is the fallback.
 */
async function openKindle(data: Blob, options: KindleOptions): Promise<KindleBook> {
  const { initKf8File, initMobiFile } = await import('@lingo-reader/mobi-parser');
  const bytes = new Uint8Array(await data.arrayBuffer());
  try {
    const kf8 = await initKf8File(bytes, options.resourceSaveDir);
    if (kf8.getSpine().length) return kf8;
    kf8.destroy();
  } catch {
    // Not KF8; try MOBI below.
  }
  try {
    return await initMobiFile(bytes, options.resourceSaveDir);
  } catch (e) {
    throw new KindleError(`Not a readable MOBI/AZW file (it may be DRM-protected): ${e instanceof Error ? e.message : e}`);
  }
}

function stripHtml(html: string): string {
  return new DOMParser().parseFromString(html, 'text/html').body.textContent?.trim() ?? '';
}

/** A Kindle file's metadata and cover, from its headers (see `kindleHeader.ts`): its text isn't read. */
export async function parseKindle(data: Blob, filename: string): Promise<ParsedItem> {
  const meta = await header(data);
  const parsed = emptyParsedItem(filename);
  parsed.title = meta.title || parsed.title;
  parsed.creators = meta.authors.map((name) => ({ name, role: 'aut' }));
  parsed.tags = splitTags(meta.subjects);
  const set = (key: string, value: string | undefined) => {
    if (value?.trim()) parsed.metadata[key] = value.trim();
  };
  set('publisher', meta.publisher);
  set('language', meta.language);
  set('published', meta.published?.slice(0, 10));
  set('description', meta.description && stripHtml(meta.description));
  const isbn = meta.isbn?.replace(/[-\s]/g, '') ?? '';
  if (/^(97[89])?\d{9}[\dX]$/i.test(isbn)) parsed.identifiers.isbn = isbn;
  if (meta.asin && /^B0[A-Z0-9]{8}$/.test(meta.asin)) parsed.identifiers.asin = meta.asin;
  if (meta.cover) parsed.cover = { data: new Blob([meta.cover.data], { type: meta.cover.mediaType }), mediaType: meta.cover.mediaType };
  return parsed;
}

/** The `id` an `[id="…"]` selector targets, as returned by `resolveHref`. */
function selectorId(selector: string): string | undefined {
  return /^\[id="(.+)"\]$/.exec(selector)?.[1] ?? /^#([\w-]+)$/.exec(selector)?.[1];
}

/** Repackages a MOBI/AZW3 as an EPUB: chapters, images, stylesheets, internal links and TOC. */
export async function kindleToEpub(data: Blob, ctx: ConvertContext, options: KindleOptions = {}): Promise<Blob> {
  const { textLength } = await header(data);
  if (textLength > MAX_CONVERT_TEXT) {
    throw new KindleError(`It’s too big to convert in the app: ${megabytes(textLength)} of text (the most is ${megabytes(MAX_CONVERT_TEXT)}).`);
  }
  const book = await openKindle(data, options);
  const fetchResource = options.fetchResource ?? fetchByUrl;
  try {
    const resources: EpubResource[] = [];
    const resourcePaths = new Map<string, string>();
    const addResource = async (url: string, folder: string): Promise<string | undefined> => {
      if (resourcePaths.has(url)) return resourcePaths.get(url);
      const resource = await fetchResource(url).catch(() => undefined);
      if (!resource) return undefined;
      const path = `${folder}/r${resources.length + 1}.${extensionFor(resource.mediaType)}`;
      resources.push({ path, mediaType: resource.mediaType, data: resource.data });
      resourcePaths.set(url, path);
      return path;
    };
    const isInternal = (url: string) => !/^(https?:|mailto:|#|data:)/i.test(url);

    // First pass: load every chapter, pulling its images and stylesheets into the package.
    const loaded: { id: string; doc: Document; stylesheets: string[] }[] = [];
    for (const { id } of book.getSpine()) {
      const chapter = book.loadChapter(id);
      if (!chapter) continue;
      const doc = new DOMParser().parseFromString(`<!doctype html><html><body>${chapter.html}</body></html>`, 'text/html');
      if (!doc.body.textContent?.trim() && !doc.body.querySelector('img, svg, image')) continue;

      for (const img of Array.from(doc.querySelectorAll('img[src]'))) {
        const src = img.getAttribute('src')!;
        const path = isInternal(src) ? await addResource(src, 'images') : undefined;
        if (path) img.setAttribute('src', `../${path}`);
      }
      for (const image of Array.from(doc.getElementsByTagName('image'))) {
        for (const attr of ['href', 'xlink:href']) {
          const href = image.getAttribute(attr);
          const path = href && isInternal(href) ? await addResource(href, 'images') : undefined;
          if (path) image.setAttribute(attr, `../${path}`);
        }
      }
      const stylesheets: string[] = [];
      for (const css of chapter.css) {
        let path = resourcePaths.get(css.href);
        if (!path) {
          const sheet = await fetchResource(css.href).catch(() => undefined);
          if (!sheet) continue;
          let text = new TextDecoder().decode(sheet.data);
          for (const match of [...text.matchAll(/url\((['"]?)([^'")]+)\1\)/g)]) {
            const target = isInternal(match[2]!) ? await addResource(match[2]!, 'fonts') : undefined;
            if (target) text = text.replace(match[0], `url("../${target}")`);
          }
          path = `styles/s${resources.length + 1}.css`;
          resources.push({ path, mediaType: 'text/css', data: text });
          resourcePaths.set(css.href, path);
        }
        stylesheets.push(path);
      }
      loaded.push({ id, doc, stylesheets });
    }
    if (loaded.length === 0) throw new KindleError('This book has no readable content');

    const fileFor = new Map(loaded.map((c) => [c.id, `text/c${c.id}.xhtml`]));
    const hrefFor = (href: string): string | undefined => {
      const resolved = book.resolveHref(href);
      const file = resolved && fileFor.get(resolved.id);
      if (!file) return undefined;
      const anchor = selectorId(resolved.selector);
      const target = loaded.find((c) => c.id === resolved.id);
      return anchor && target?.doc.getElementById(anchor) ? `${file}#${anchor}` : file;
    };

    // Second pass: point internal links at the chapter files they now live in.
    for (const { doc } of loaded) {
      for (const a of Array.from(doc.querySelectorAll('a[href]'))) {
        const href = a.getAttribute('href')!;
        if (!isInternal(href)) continue;
        const target = hrefFor(href);
        if (target) a.setAttribute('href', `../${target}`);
        else a.removeAttribute('href');
      }
    }

    const tocEntries = (items: { label: string; href: string; children?: typeof items }[]): EpubTocEntry[] =>
      items.flatMap((item) => {
        const href = hrefFor(item.href);
        const children = tocEntries(item.children ?? []);
        if (!href) return children;
        return [{ label: item.label.trim() || 'Untitled', href, ...(children.length && { children }) }];
      });
    const toc = tocEntries(book.getToc());
    const titleFor = (id: string, doc: Document, index: number) =>
      toc.find((t) => t.href.split('#')[0] === fileFor.get(id))?.label ??
      doc.querySelector('h1, h2, h3')?.textContent?.trim() ??
      `Section ${index + 1}`;

    const chapters: EpubChapter[] = loaded.map(({ id, doc, stylesheets }, i) => ({
      id: `c${id}`,
      title: titleFor(id, doc, i),
      body: htmlToXhtml(doc.body.innerHTML),
      stylesheets,
    }));
    return await buildEpub({ ...bookFromItem(ctx), chapters, resources, ...(toc.length && { toc }) });
  } finally {
    book.destroy();
  }
}
