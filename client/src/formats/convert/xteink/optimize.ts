import JSZip from 'jszip';
import { parseXml } from '../../xml';
import { processImage, type Profile } from './image';
import { DEFAULT_OPTIMIZE_OPTIONS, type OptimizeOptions } from './options';
import { basename, splitEpubText, type EpubEntries } from './textsplit';

/**
 * Optimizes an EPUB for a CrossPoint reader (Xteink X4/X3), ported from
 * `crosspoint_reader/optimizer.py` in the CrossPoint Calibre plugins (MIT),
 * which mirrors the device web UI's optimizer:
 *
 * - every raster image is re-encoded for the screen (see `image.ts`) and renamed `.jpg`;
 * - markup is fixed up: references renamed, stale `<img>` sizes stripped,
 *   SVG-wrapped images unwrapped, a small defensive stylesheet injected;
 * - the OPF gets JPEG media types, no `svg` properties and a cover meta; the NCX's
 *   identifier is synced with the OPF's;
 * - then the text passes (`textsplit.ts`) split what the firmware can't hold in RAM.
 *
 * Markup is rewritten with string operations (the Python's fallback path), so
 * anything not being fixed stays byte-for-byte as it was.
 */

export { DEFAULT_OPTIMIZE_OPTIONS, type OptimizeOptions } from './options';

export type ImageProcessor = (data: Uint8Array, path: string) => Promise<Uint8Array>;

const RASTER_RE = /\.(png|gif|webp|bmp|jpe?g)$/i;
/** A whole path or attribute value to rename. */
const RENAME_RE = /\.(png|gif|webp|bmp|jpeg)$/i;
/** References inside markup and CSS (href, src, url(…)). */
const REF_RE = /\.(?:png|gif|webp|bmp|jpeg)(?=["')\s#?>])/gi;
const XHTML_RE = /\.(xhtml|html|htm)$/i;

export const DEFENSIVE_STYLE =
  '<style type="text/css">img,svg{max-width:100%;height:auto}body{overflow-wrap:break-word}' +
  'table{max-width:100%;table-layout:fixed}pre,code{white-space:pre-wrap;word-wrap:break-word}' +
  '*{box-sizing:border-box}</style>';

export async function optimizeEpub(
  data: Blob,
  profile: Profile,
  options: OptimizeOptions = DEFAULT_OPTIMIZE_OPTIONS,
  image: ImageProcessor = (bytes, path) => processImage(bytes, path, profile, options),
  log: (message: string) => void = () => undefined,
): Promise<Blob> {
  const zip = await JSZip.loadAsync(await data.arrayBuffer());
  const order: string[] = [];
  zip.forEach((path, file) => {
    if (!file.dir && path !== 'mimetype') order.push(path);
  });
  const opfPath = (await rootfilePath(zip)) ?? order.find((p) => p.toLowerCase().endsWith('.opf'));
  if (!opfPath) throw new Error('The EPUB has no package document.');
  const opfText = decodeText(await zip.file(opfPath)!.async('uint8array'));
  const identifier = extractIdentifier(opfText);

  const entries: EpubEntries = { order: [], data: new Map(), opfPath };
  const add = (path: string, value: Uint8Array | string) => {
    if (!entries.data.has(path)) entries.order.push(path);
    entries.data.set(path, value);
  };
  for (const path of order) {
    const raw = await zip.file(path)!.async('uint8array');
    const lower = path.toLowerCase();
    if (RASTER_RE.test(lower)) {
      const renamed = path.replace(RENAME_RE, '.jpg');
      try {
        add(renamed, await image(raw, path));
      } catch (e) {
        // References to it have been renamed along with every other image's, so it keeps the new name.
        log(`${basename(path)}: kept as it was (${e instanceof Error ? e.message : e})`);
        add(renamed, raw);
      }
    } else if (XHTML_RE.test(lower)) {
      add(path, fixXhtml(decodeText(raw)));
    } else if (path === opfPath) {
      add(path, fixOpf(renameRefs(decodeText(raw))));
    } else if (lower.endsWith('.ncx')) {
      add(path, syncNcxIdentifier(renameRefs(decodeText(raw)), identifier));
    } else if (lower.endsWith('.css')) {
      add(path, renameRefs(decodeText(raw)));
    } else {
      add(path, raw);
    }
  }

  // Always runs, for the font, data-image and page-list cleanup; the options pick the splitting passes.
  try {
    const split = { paragraphs: options.splitParagraphs, chapters: options.splitChapters };
    await splitEpubText(entries, (bytes, name) => image(bytes, name), log, split);
  } catch (e) {
    // Best effort, as in the Python: the image and container fixes still apply.
    log(`text splitting skipped: ${e instanceof Error ? e.message : e}`);
  }

  const out = new JSZip();
  out.file('mimetype', 'application/epub+zip', { compression: 'STORE' });
  for (const path of entries.order) {
    // JPEGs don't compress further; the device reads stored entries fastest. No directory entries, as the Python.
    const stored = /\.jpe?g$/i.test(path);
    out.file(path, entries.data.get(path)!, { compression: stored ? 'STORE' : 'DEFLATE', createFolders: false });
  }
  return out.generateAsync({ type: 'blob', mimeType: 'application/epub+zip' });
}

async function rootfilePath(zip: JSZip): Promise<string | undefined> {
  const container = Object.keys(zip.files).find((p) => p.toLowerCase() === 'meta-inf/container.xml');
  const xml = container && (await zip.file(container)!.async('string'));
  const path = xml ? /<rootfile[^>]+full-path=["']([^"']+)["']/i.exec(xml)?.[1] : undefined;
  return path && zip.file(path) ? path : undefined;
}

/** UTF-8 (without a BOM), or else the encoding the XML declaration or meta charset names. */
export function decodeText(raw: Uint8Array): string {
  const bytes = raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf ? raw.subarray(3) : raw;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    const head = new TextDecoder('ascii').decode(bytes.subarray(0, 512));
    const encoding = (/encoding=["']([^"']+)["']/i.exec(head) ?? /charset=["']?([^"'\s;]+)/i.exec(head))?.[1];
    try {
      return new TextDecoder(encoding ?? 'windows-1252').decode(bytes);
    } catch {
      return new TextDecoder('iso-8859-1').decode(bytes);
    }
  }
}

export const renameRefs = (text: string) => text.replace(REF_RE, '.jpg');

const STYLE_DECLARATION_RE =
  /(?:^|(?<=;))(\s*)([-_a-zA-Z][-_a-zA-Z0-9]*)\s*:((?:[^;"'()]|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\((?:\\.|[^()\\])*\))*)(\s*)(;?)/g;

/** Drops width and height from an inline style, which were set for the image before it was resized. */
function stripSizeDeclarations(style: string): string {
  return style.replace(STYLE_DECLARATION_RE, (m, _lead, property: string) =>
    ['width', 'height'].includes(property.trim().toLowerCase()) ? '' : m,
  );
}

/** Removes width and height (attributes and inline styles) from every `<img>`. */
export function stripImgDimensions(text: string): string {
  return text.replace(/<img\b[^>]*>/gi, (tag) =>
    tag
      .replace(/\s+(?:width|height)\s*=\s*"[^"]*"/gi, '')
      .replace(/\s+(?:width|height)\s*=\s*'[^']*'/gi, '')
      .replace(/\s+style=(["'])([\s\S]*?)\1/gi, (m, quote: string, style: string) => {
        const fixed = stripSizeDeclarations(style);
        if (fixed === style) return m;
        return fixed.trim() ? ` style=${quote}${fixed}${quote}` : '';
      }),
  );
}

const SVG_IMAGE_RE =
  /<(?:svg:)?svg\b[^>]*>[\s\S]*?<(?:svg:)?image\b[^>]*?(?:xlink:href|href)=["']([^"']+)["'][\s\S]*?<\/(?:svg:)?svg>/gi;

/** Replaces SVG-wrapped images (common for covers), which the firmware can't render, with plain `<img>`s. */
export function unwrapSvgImages(text: string): string {
  if (!text.includes('<svg') || !text.includes('href')) return text;
  return text.replace(
    SVG_IMAGE_RE,
    (_m, href: string) => `<img style="max-width:100%;height:auto" src="${href.replace(RENAME_RE, '.jpg')}" alt="" />`,
  );
}

export function fixXhtml(text: string): string {
  text = stripImgDimensions(renameRefs(unwrapSvgImages(text)));
  if (text.includes('</head>') && !text.includes(DEFENSIVE_STYLE)) text = text.replace('</head>', `${DEFENSIVE_STYLE}</head>`);
  return text;
}

/** JPEG media types for renamed images, no `svg` properties, and a cover meta pointing at the cover image. */
export function fixOpf(text: string): string {
  let out = text.replace(/<(?:\w+:)?item\b[^>]*>/g, (tag) => {
    const href = /\bhref="([^"]*)"/.exec(tag)?.[1] ?? '';
    if (/\.jpg$/i.test(href)) tag = tag.replace(/media-type="image\/(?:png|gif|webp|bmp)"/, 'media-type="image/jpeg"');
    return tag.replace(/\sproperties="([^"]*)"/, (_m, properties: string) => {
      const kept = properties.split(/\s+/).filter((p) => p && p !== 'svg');
      return kept.length ? ` properties="${kept.join(' ')}"` : '';
    });
  });
  const coverId = findCoverId(out);
  if (!coverId) return out;
  const coverMeta = /<(?:\w+:)?meta\b[^>]*\bname="cover"[^>]*>/.exec(out);
  if (coverMeta) {
    if (/\bcontent="([^"]*)"/.exec(coverMeta[0])?.[1] !== coverId) {
      out = out.replace(coverMeta[0], coverMeta[0].replace(/\bcontent="[^"]*"/, `content="${coverId}"`));
    }
  } else {
    out = out.replace(/<\/((?:\w+:)?)metadata>/, (close, prefix: string) => `<${prefix}meta name="cover" content="${coverId}"/>${close}`);
  }
  return out;
}

/** The manifest id of the cover image: the `cover-image` item, or else an image with "cover" in its id or href. */
function findCoverId(opf: string): string | undefined {
  const doc = parseXml(opf);
  const items = doc
    ? Array.from(doc.getElementsByTagName('*')).filter((el) => el.localName === 'item')
    : [];
  const images = items.filter((el) => (el.getAttribute('media-type') ?? '').startsWith('image/'));
  const cover =
    images.find((el) => (el.getAttribute('properties') ?? '').split(/\s+/).includes('cover-image')) ??
    images.find((el) => `${el.getAttribute('id')} ${el.getAttribute('href')}`.toLowerCase().includes('cover'));
  return cover?.getAttribute('id') ?? undefined;
}

export function extractIdentifier(opf: string): string | undefined {
  const uid = /<(?:\w+:)?package[^>]*unique-identifier=["']([^"']+)["']/i.exec(opf)?.[1];
  if (uid) {
    const escaped = uid.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const value = new RegExp(`<dc:identifier[^>]*id=["']${escaped}["'][^>]*>([^<]+)</dc:identifier>`, 'i').exec(opf)?.[1];
    if (value) return value.trim();
  }
  return /<dc:identifier[^>]*>([^<]+)</i.exec(opf)?.[1]?.trim();
}

export function syncNcxIdentifier(ncx: string, identifier: string | undefined): string {
  if (!identifier) return ncx;
  const escaped = identifier.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  return ncx.replace(/(<meta\s+name=["']dtb:uid["']\s+content=)["'][^"']*["']/i, (_m, pre: string) => `${pre}"${escaped}"`);
}
