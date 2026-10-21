import type { ConvertContext } from '../convert/bookFromItem';
import { creatorRecords, coverRecords, EXTH, gatherResources, languageCode, metadataRecords, type Resources } from './book';
import { rewriteCssUrls } from './css';
import { isExternal, resolveHref, fragmentOf, type EpubPackage, type TocNode } from './epub';
import {
  ByteWriter,
  elements,
  escapeAttribute,
  escapeText,
  lonelySvgImage,
  removeComments,
  svgImageHref,
  utf8Length,
  VOID_ELEMENTS,
} from './markup';
import {
  ascii,
  base32,
  concat,
  EOF_RECORD,
  exthBlock,
  exthNumber,
  exthText,
  FLIS,
  indexRecords,
  NULL_INDEX,
  padTo4,
  repeat,
  PALMDOC,
  palmDatabase,
  Strings,
  textRecords,
  TEXT_RECORD_SIZE,
  trailingEntry,
  u16,
  u32,
  utf8,
  type IndexTag,
} from './records';
import { kf8Tbs, type TocEntry } from './tbs';
import { parseXml } from '../xml';

/**
 * KF8 (AZW3), the format Kindles have read since 2011: the book's own XHTML and CSS, laid out as
 * kindlegen lays it out. Each content document becomes a skeleton (its markup with the body's
 * content taken out) and fragments of that content, at most 8 KB each where the markup allows,
 * all in one text flow; stylesheets and SVG images are flows of their own. Images and fonts
 * are records, linked as `kindle:embed:XXXX`; links within the book become `kindle:pos:fid:`
 * positions (a fragment and an offset in it), found through the anchors (`aid` attributes)
 * written on elements. Indexes list the skeletons, the fragments, the table of contents and
 * the guide. Calibre's writer (`ebooks/mobi/writer8`) documents the layout.
 */

const CHUNK_SIZE = 8192;

/** Elements kindlegen gives an anchor, so links and the table of contents can point at them. */
const ANCHORED = new Set(
  'a abbr address article aside audio b bdo blockquote body button cite code dd del details dfn div dl dt em fieldset figcaption figure footer h1 h2 h3 h4 h5 h6 header hgroup i ins kbd label legend li map mark meter nav ol output p pre progress q rp rt samp section select small span strong sub summary sup textarea time ul var video'.split(
    ' ',
  ),
);

const XHTML_NS = 'http://www.w3.org/1999/xhtml';
/** A link's placeholder until positions are known, as long as the link it becomes. */
const LINK_PLACEHOLDER = 'kindle:pos:fid:0000:off:0000000000';

interface Anchor {
  /** `aid` (may hold fragments) or `cid` (an id within a table, which kindlegen doesn't fragment). */
  attribute: 'aid' | 'cid';
  value: string;
}

interface Chunk {
  start: number;
  end: number;
  selector: string;
}

interface Serialized {
  bytes: Uint8Array<ArrayBuffer>;
  chunks: Chunk[];
  /** Each anchor's offset in the file. */
  anchors: Map<string, number>;
  links: { at: number; path: string; fragment?: string }[];
}

/** The flows besides the text: stylesheets (by path, or inline by their text) and SVG images. */
class Flows {
  readonly texts: string[] = [];
  readonly #keys = new Map<string, number>();

  /** The flow's number (1 the first after the text), adding it with `make` the first time. */
  add(key: string, make: () => string): number {
    let index = this.#keys.get(key);
    if (index === undefined) {
      // Reserve the number first, so a stylesheet importing itself doesn't loop.
      index = this.texts.length + 1;
      this.#keys.set(key, index);
      this.texts.push('');
      this.texts[index - 1] = make();
    }
    return index;
  }
}

const flowUrl = (index: number, mime: string) => `kindle:flow:${base32(index, 4)}?mime=${mime}`;

class Kf8Book {
  readonly flows = new Flows();
  readonly anchorsById = new Map<string, string>();
  readonly #cssText = new Map<string, string>();
  /** SVG files' text, read beforehand, for those linked as images. */
  readonly svgFiles = new Map<string, string>();

  constructor(
    readonly pkg: EpubPackage,
    readonly resources: Resources,
  ) {}

  embed(path: string): string | undefined {
    const image = this.resources.images.get(path);
    if (image) return `kindle:embed:${base32(image.index, 4)}?mime=${image.type}`;
    const font = this.resources.fonts.get(path);
    return font === undefined ? undefined : `kindle:embed:${base32(font, 4)}`;
  }

  /** A stylesheet's text with its references as KF8's. */
  css(text: string, from: string): string {
    return rewriteCssUrls(text, (url, isImport) => {
      if (isExternal(url) || url.startsWith('data:')) return undefined;
      const path = resolveHref(from, url);
      if (isImport) return this.#cssText.has(path) ? flowUrl(this.stylesheet(path), 'text/css') : undefined;
      return this.embed(path);
    });
  }

  setCss(path: string, text: string) {
    this.#cssText.set(path, text);
  }

  stylesheet(path: string): number {
    return this.flows.add(`css:${path}`, () => this.css(this.#cssText.get(path) ?? '', path));
  }

  /** An SVG image as a flow, its own images as KF8's. */
  svg(key: string, svg: Element, from: string): number {
    return this.flows.add(key, () => {
      for (const image of elements(svg, 'image')) {
        const href = svgImageHref(image);
        const embed = href && !isExternal(href) ? this.embed(resolveHref(from, href)) : undefined;
        if (embed) {
          image.removeAttribute('href');
          image.setAttributeNS('http://www.w3.org/1999/xlink', 'xlink:href', embed);
        }
      }
      return `<?xml version="1.0" encoding="UTF-8"?>\n${new XMLSerializer().serializeToString(svg)}`;
    });
  }

  /** An SVG file's flow, or undefined if it isn't one that parses. */
  svgFile(path: string): number | undefined {
    const svg = parseXml(this.svgFiles.get(path) ?? '')?.documentElement;
    return svg?.localName === 'svg' ? this.svg(`svg:${path}`, svg, path) : undefined;
  }
}

/** The images and fonts the book's documents and stylesheets use, in the order they're used. */
async function usedResources(pkg: EpubPackage, docs: { path: string; doc: Document }[]) {
  const images: string[] = [];
  const fonts: string[] = [];
  const add = (path: string) => {
    const item = pkg.byPath.get(path);
    const type = item?.mediaType ?? '';
    if (type.startsWith('image/') && type !== 'image/svg+xml') images.push(path);
    else if (/font|opentype|truetype|application\/(x-)?font|vnd\.ms-opentype/.test(type) || /\.(ttf|otf)$/i.test(path)) fonts.push(path);
  };
  const seenCss = new Set<string>();
  const css = async (path: string) => {
    if (seenCss.has(path)) return;
    seenCss.add(path);
    const text = await pkg.text(path);
    if (text) await cssRefs(text, path);
  };
  const cssRefs = async (text: string, from: string) => {
    const imports: string[] = [];
    rewriteCssUrls(text, (url, isImport) => {
      if (isExternal(url) || url.startsWith('data:')) return undefined;
      if (isImport) imports.push(resolveHref(from, url));
      else add(resolveHref(from, url));
      return undefined;
    });
    for (const path of imports) await css(path);
  };
  for (const { path, doc } of docs) {
    for (const el of elements(doc)) {
      const href = el.localName === 'img' ? el.getAttribute('src') : el.localName === 'image' ? svgImageHref(el) : undefined;
      if (href && !isExternal(href)) add(resolveHref(path, href));
      if (el.localName === 'link' && /stylesheet/i.test(el.getAttribute('rel') ?? '') && el.getAttribute('href')) await css(resolveHref(path, el.getAttribute('href')!));
      if (el.localName === 'style' && el.textContent) await cssRefs(el.textContent, path);
      const style = el.getAttribute('style');
      if (style) await cssRefs(style, path);
    }
  }
  return { images, fonts, stylesheets: [...seenCss] };
}

/** Rewrites a document's references for KF8, and gives its elements anchors. */
function prepare(book: Kf8Book, path: string, doc: Document, fileNumber: number, spinePaths: Set<string>) {
  const root = doc.documentElement;
  removeComments(root);
  for (const el of elements(doc)) {
    const name = el.localName;
    if (name === 'script' || name === 'base' || name === 'source') el.remove();
    else if (name === 'link') {
      const href = el.getAttribute('href');
      if (!/stylesheet/i.test(el.getAttribute('rel') ?? '') || !href || isExternal(href)) el.remove();
      else el.setAttribute('href', flowUrl(book.stylesheet(resolveHref(path, href)), 'text/css'));
    } else if (name === 'style') {
      const text = el.textContent ?? '';
      if (!text.trim()) {
        el.remove();
        continue;
      }
      const link = doc.createElementNS(XHTML_NS, 'link');
      link.setAttribute('rel', 'stylesheet');
      link.setAttribute('type', 'text/css');
      // Identical styles share a flow, as kindlegen's do.
      const folder = path.slice(0, path.lastIndexOf('/') + 1);
      link.setAttribute('href', flowUrl(book.flows.add(`style:${folder}\0${text}`, () => book.css(text, path)), 'text/css'));
      el.replaceWith(link);
    } else if (name === 'img') {
      // Kindles take only `src`; the alternatives would point at nothing.
      el.removeAttribute('srcset');
      el.removeAttribute('sizes');
      const src = el.getAttribute('src');
      if (!src || isExternal(src) || src.startsWith('data:')) continue;
      const target = resolveHref(path, src);
      const embed = book.embed(target);
      const svg = embed ? undefined : book.svgFile(target);
      if (embed) el.setAttribute('src', embed);
      else if (svg !== undefined) el.setAttribute('src', flowUrl(svg, 'image/svg+xml'));
      else el.replaceWith(doc.createTextNode(el.getAttribute('alt') ?? ''));
    } else if (name === 'svg' && !el.parentElement?.closest('svg')) {
      const image = lonelySvgImage(el);
      const href = image && svgImageHref(image);
      const img = doc.createElementNS(XHTML_NS, 'img');
      const embed = href && !isExternal(href) ? book.embed(resolveHref(path, href)) : undefined;
      if (embed) {
        img.setAttribute('src', embed);
        img.setAttribute('alt', '');
      } else {
        img.setAttribute('src', flowUrl(book.svg(`inline:${path}:${book.flows.texts.length}`, el.cloneNode(true) as Element, path), 'image/svg+xml'));
      }
      el.replaceWith(img);
    } else if (name === 'a' && !el.hasAttribute('id') && el.getAttribute('name')) {
      el.setAttribute('id', el.getAttribute('name')!);
    }
  }

  const links = new Map<Element, { path: string; fragment?: string }>();
  for (const a of elements(doc, 'a')) {
    const href = a.getAttribute('href');
    if (!href || isExternal(href)) continue;
    const target = href.startsWith('#') ? path : resolveHref(path, href);
    if (spinePaths.has(target)) links.set(a, { path: target, ...(fragmentOf(href) && { fragment: fragmentOf(href) }) });
    else a.removeAttribute('href');
  }

  // Anchors: every anchored element, and anything with an id; within tables only those with ids, as `cid`.
  const anchors = new Map<Element, Anchor>();
  const seen = new Set<string>();
  let j = 0;
  let cid = 0;
  for (const el of elements(doc)) {
    let id = el.getAttribute('id') ?? undefined;
    if (id && seen.has(id)) {
      el.removeAttribute('id');
      id = undefined;
    }
    if (id) seen.add(id);
    if (!id && !ANCHORED.has(el.localName)) continue;
    let anchor: Anchor;
    if (el.localName === 'table' || el.closest('table')) {
      if (!id) continue;
      anchor = { attribute: 'cid', value: `c${++cid}` };
    } else {
      anchor = { attribute: 'aid', value: base32(fileNumber * 1_000_000 + j++) };
    }
    anchors.set(el, anchor);
    if (id) book.anchorsById.set(`${path}#${id}`, `${fileNumber}:${anchor.value}`);
    if (el.localName === 'body') book.anchorsById.set(`${path}#`, `${fileNumber}:${anchor.value}`);
  }
  return { links, anchors };
}

/** An element's attributes as written: without namespaces (KF8's markup has none), the anchor last. */
function attributes(el: Element, anchor: Anchor | undefined, link: boolean): [string, string][] {
  const out = new Map<string, string>();
  for (const attr of Array.from(el.attributes)) {
    const name = attr.localName;
    if (attr.name.startsWith('xmlns') || attr.prefix === 'epub' || name === 'aid' || name === 'cid' || /^on/i.test(name)) continue;
    if (!out.has(name)) out.set(name, attr.value);
  }
  if (link) out.set('href', LINK_PLACEHOLDER);
  if (anchor) out.set(anchor.attribute, anchor.value);
  return [...out];
}

/** A document serialized as KF8 keeps it, with its body's content in fragments. */
function serialize(doc: Document, prepared: ReturnType<typeof prepare>): Serialized {
  const { links, anchors } = prepared;
  const lengths = new Map<Node, number>();
  const openTag = (el: Element) =>
    `<${el.localName}${attributes(el, anchors.get(el), links.has(el))
      .map(([k, v]) => ` ${k}="${escapeAttribute(v)}"`)
      .join('')}${VOID_ELEMENTS.has(el.localName) ? '/' : ''}>`;
  const length = (node: Node): number => {
    let n = lengths.get(node);
    if (n !== undefined) return n;
    if (node.nodeType === 3) n = utf8Length(escapeText(node.nodeValue ?? ''));
    else if (node.nodeType === 1) {
      const el = node as Element;
      n = utf8Length(openTag(el));
      if (!VOID_ELEMENTS.has(el.localName)) {
        for (const child of el.childNodes) n += length(child);
        n += utf8Length(`</${el.localName}>`);
      }
    } else n = 0;
    lengths.set(node, n);
    return n;
  };

  // The body's content goes into fragments; elements too big for one, that have anchors, are
  // stepped into, staying in the skeleton with their content in fragments of its own.
  const body = elements(doc, 'body')[0];
  const fragmented = new Set<Node>();
  const steppedInto = new Set<Element>();
  const stepInto = (el: Element) => {
    steppedInto.add(el);
    for (const child of el.childNodes) {
      if (child.nodeType === 3) {
        if (child.nodeValue?.trim()) fragmented.add(child);
      } else if (child.nodeType === 1) {
        const element = child as Element;
        if (length(element) > CHUNK_SIZE && anchors.get(element)?.attribute === 'aid' && element.childNodes.length) stepInto(element);
        else fragmented.add(element);
      }
    }
  };
  if (body) stepInto(body);
  const selector = (node: Node) => {
    for (let sibling = node.previousSibling; sibling; sibling = sibling.previousSibling) {
      if (steppedInto.has(sibling as Element)) return `S-//*[@aid='${anchors.get(sibling as Element)!.value}']`;
    }
    return `P-//*[@aid='${anchors.get(node.parentNode as Element)!.value}']`;
  };

  const out = new ByteWriter();
  const chunks: Chunk[] = [];
  const anchorOffsets = new Map<string, number>();
  const linkOffsets: Serialized['links'] = [];
  const write = (node: Node) => {
    const fragment = fragmented.has(node);
    if (fragment) {
      const last = chunks.at(-1);
      if (last && last.end === out.length && last.end - last.start + length(node) <= CHUNK_SIZE) last.end = -1;
      else chunks.push({ start: out.length, end: -1, selector: selector(node) });
    }
    if (node.nodeType === 3) out.write(escapeText(node.nodeValue ?? ''));
    else if (node.nodeType === 1) {
      const el = node as Element;
      const anchor = anchors.get(el);
      if (anchor) anchorOffsets.set(anchor.value, out.length);
      const tag = openTag(el);
      const link = links.get(el);
      if (link) linkOffsets.push({ at: out.length + utf8Length(tag.slice(0, tag.indexOf(LINK_PLACEHOLDER))), ...link });
      out.write(tag);
      if (!VOID_ELEMENTS.has(el.localName)) {
        for (const child of el.childNodes) write(child);
        out.write(`</${el.localName}>`);
      }
    }
    if (fragment) chunks.at(-1)!.end = out.length;
  };

  const root = doc.documentElement;
  const rootAttributes = ['lang', 'class', 'style']
    .map((name) => [name, name === 'lang' ? (root.getAttribute('lang') ?? root.getAttributeNS('http://www.w3.org/XML/1998/namespace', 'lang') ?? root.getAttribute('xml:lang')) : root.getAttribute(name)] as const)
    .filter(([, value]) => value)
    .map(([name, value]) => ` ${name}="${escapeAttribute(value!)}"`)
    .join('');
  out.write(`<?xml version="1.0" encoding="UTF-8"?>\n<html xmlns="${XHTML_NS}"${rootAttributes}>`);
  for (const child of root.childNodes) write(child);
  out.write('</html>');
  return { bytes: out.bytes(), chunks, anchors: anchorOffsets, links: linkOffsets };
}

interface TableChunk {
  insertAt: number;
  selector: string;
  file: number;
  sequence: number;
  start: number;
  length: number;
}

/** Where an anchor at `offset` in the text is: the fragment holding it and the offset within, else the next fragment's start. */
function position(table: TableChunk[], offset: number): [number, number] {
  let lo = 0;
  let hi = table.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (table[mid]!.insertAt <= offset) lo = mid;
    else hi = mid - 1;
  }
  const chunk = table[lo];
  if (!chunk) return [0, 0];
  if (offset < chunk.insertAt) return [chunk.sequence, 0];
  if (offset < chunk.insertAt + chunk.length || lo === table.length - 1) return [chunk.sequence, offset - chunk.insertAt];
  return [table[lo + 1]!.sequence, 0];
}

const SKELETON_TAGS: IndexTag[] = [
  { name: 'chunkCount', number: 1, valuesPerEntry: 1, mask: 3 },
  { name: 'geometry', number: 6, valuesPerEntry: 2, mask: 12 },
];
const CHUNK_TAGS: IndexTag[] = [
  { name: 'selector', number: 2, valuesPerEntry: 1, mask: 1 },
  { name: 'file', number: 3, valuesPerEntry: 1, mask: 2 },
  { name: 'sequence', number: 4, valuesPerEntry: 1, mask: 4 },
  { name: 'geometry', number: 6, valuesPerEntry: 2, mask: 8 },
];
const NCX_TAGS: IndexTag[] = [
  { name: 'offset', number: 1, valuesPerEntry: 1, mask: 1 },
  { name: 'length', number: 2, valuesPerEntry: 1, mask: 2 },
  { name: 'label', number: 3, valuesPerEntry: 1, mask: 4 },
  { name: 'depth', number: 4, valuesPerEntry: 1, mask: 8 },
  { name: 'parent', number: 21, valuesPerEntry: 1, mask: 16 },
  { name: 'firstChild', number: 22, valuesPerEntry: 1, mask: 32 },
  { name: 'lastChild', number: 23, valuesPerEntry: 1, mask: 64 },
  { name: 'posFid', number: 6, valuesPerEntry: 2, mask: 128 },
];
const GUIDE_TAGS: IndexTag[] = [
  { name: 'title', number: 1, valuesPerEntry: 1, mask: 1 },
  { name: 'posFid', number: 6, valuesPerEntry: 2, mask: 2 },
];

const fcis = (textLength: number) =>
  concat([ascii('FCIS'), u32(0x14), u32(0x10), u32(2), u32(0), u32(textLength), u32(0), u32(0x28), u32(0), u32(0x28), u32(8), u16(1), u16(1), u32(0)]);

/** The book as KF8. */
export async function writeKf8(pkg: EpubPackage, ctx: ConvertContext): Promise<Blob> {
  const docs: { path: string; doc: Document }[] = [];
  for (const item of pkg.spine) {
    const doc = await pkg.document(item.path);
    if (doc && elements(doc, 'body')[0]) docs.push({ path: item.path, doc });
  }
  const used = await usedResources(pkg, docs);
  const resources = await gatherResources(pkg, ctx, used.images, used.fonts);
  const book = new Kf8Book(pkg, resources);
  for (const path of used.stylesheets) book.setCss(path, (await pkg.text(path)) ?? '');
  for (const item of pkg.manifest) {
    if (item.mediaType === 'image/svg+xml') book.svgFiles.set(item.path, (await pkg.text(item.path)) ?? '');
  }

  const spinePaths = new Set(docs.map((d) => d.path));
  const files = docs.map(({ path, doc }, i) => serialize(doc, prepare(book, path, doc, i, spinePaths)));

  // Lay the files out one after another, and find every fragment and anchor.
  const table: TableChunk[] = [];
  const skeletons: { file: number; start: number; length: number; chunks: number }[] = [];
  const anchorPositions = new Map<string, { offset: number; posFid: [number, number] }>();
  let start = 0;
  for (const [file, serialized] of files.entries()) {
    let within = 0;
    for (const chunk of serialized.chunks) {
      table.push({ insertAt: start + chunk.start, selector: chunk.selector, file, sequence: table.length, start: within, length: chunk.end - chunk.start });
      within += chunk.end - chunk.start;
    }
    skeletons.push({ file, start, length: serialized.bytes.length - within, chunks: serialized.chunks.length });
    start += serialized.bytes.length;
  }
  const textLength = start;
  for (const [file, serialized] of files.entries()) {
    const fileStart = skeletons[file]!.start;
    for (const [value, offset] of serialized.anchors) {
      anchorPositions.set(`${file}:${value}`, { offset: fileStart + offset, posFid: position(table, fileStart + offset) });
    }
  }
  const locate = (path: string, fragment?: string) => {
    const anchor = (fragment && book.anchorsById.get(`${path}#${fragment}`)) || book.anchorsById.get(`${path}#`);
    return anchor ? anchorPositions.get(anchor) : undefined;
  };

  // Links, now that positions are known; then each file as its skeleton followed by its fragments.
  const text: Uint8Array[] = [];
  for (const serialized of files) {
    for (const link of serialized.links) {
      const [fid, off] = locate(link.path, link.fragment)?.posFid ?? [0, 0];
      serialized.bytes.set(utf8(`kindle:pos:fid:${base32(fid, 4)}:off:${base32(off, 10)}`), link.at);
    }
    let at = 0;
    for (const chunk of serialized.chunks) {
      text.push(serialized.bytes.subarray(at, chunk.start));
      at = chunk.end;
    }
    text.push(serialized.bytes.subarray(at));
    for (const chunk of serialized.chunks) text.push(serialized.bytes.subarray(chunk.start, chunk.end));
  }
  const flows = [concat(text), ...book.flows.texts.map(utf8)];
  const allText = concat(flows);
  const { records: textRecs, lengths } = textRecords(allText);

  // The table of contents, depth first, then ordered by depth and position as Kindles need.
  const toc = tocEntries(pkg.toc, locate, table, textLength);
  if (toc.length) {
    const tbs = kf8Tbs(toc, lengths);
    for (const [i, sequences] of tbs.entries()) textRecs[i] = concat([textRecs[i]!, trailingEntry(sequences)]);
  }

  const records: Uint8Array[] = [new Uint8Array(0), ...textRecs];
  const textSize = textRecs.reduce((n, r) => n + r.length, 0);
  if (textSize % 4) records.push(new Uint8Array(textSize % 4));
  const firstNonText = records.length;

  const chunkStrings = new Strings(table.map((c) => c.selector));
  const chunkIndex = records.length;
  records.push(
    ...indexRecords(
      CHUNK_TAGS,
      table.map((c) => ({
        name: String(c.insertAt).padStart(10, '0'),
        values: { selector: chunkStrings.offset(c.selector), file: c.file, sequence: c.sequence, geometry: [c.start, c.length] },
      })),
      chunkStrings,
    ),
  );
  const skelIndex = records.length;
  records.push(
    ...indexRecords(
      SKELETON_TAGS,
      skeletons.map((s) => ({
        name: `SKEL${String(s.file).padStart(10, '0')}`,
        values: { chunkCount: [s.chunks, s.chunks], geometry: [s.start, s.length, s.start, s.length] },
      })),
    ),
  );

  let guideIndex = NULL_INDEX;
  let startReading: number | undefined;
  const guide = pkg.landmarks
    .map((l) => ({ ...l, position: locate(l.path, l.fragment) }))
    .filter((l) => l.position)
    .sort((a, b) => (a.type < b.type ? -1 : a.type > b.type ? 1 : 0));
  if (guide.length) {
    const strings = new Strings(guide.map((g) => g.title));
    guideIndex = records.length;
    records.push(...indexRecords(GUIDE_TAGS, guide.map((g) => ({ name: g.type, values: { title: strings.offset(g.title), posFid: g.position!.posFid } })), strings));
    startReading = guide.find((g) => g.type === 'text' || g.type === 'start' || g.title.toLowerCase() === 'start')?.position?.offset;
  }

  let ncxIndex = NULL_INDEX;
  if (toc.length) {
    const strings = new Strings(toc.map((e) => e.label));
    const digits = Math.max(2, (toc.length - 1).toString(16).length);
    ncxIndex = records.length;
    records.push(
      ...indexRecords(
        NCX_TAGS,
        toc.map((e) => ({
          name: (e.index.toString(16).toUpperCase()).padStart(digits, '0'),
          values: {
            offset: e.offset,
            length: e.length,
            label: strings.offset(e.label),
            depth: e.depth,
            ...(e.parent !== undefined && { parent: e.parent }),
            ...(e.firstChild !== undefined && { firstChild: e.firstChild, lastChild: e.lastChild! }),
            posFid: e.posFid,
          },
        })),
        strings,
      ),
    );
  }

  const firstResource = resources.records.length ? records.length : NULL_INDEX;
  records.push(...resources.records);
  const fdstRecord = records.length;
  let flowStart = 0;
  const fdst = flows.flatMap((f) => {
    const range = [flowStart, flowStart + f.length];
    flowStart += f.length;
    return range;
  });
  records.push(concat([ascii('FDST'), u32(12), u32(flows.length), fdst.flatMap(u32)]));
  const flisRecord = records.length;
  records.push(FLIS);
  const fcisRecord = records.length;
  records.push(fcis(allText.length));
  records.push(EOF_RECORD);

  const exth = exthBlock([
    ...metadataRecords(ctx),
    ...creatorRecords(true),
    ...coverRecords(resources, true),
    ...(startReading !== undefined ? [exthNumber(EXTH.startReading, startReading)] : []),
    exthNumber(EXTH.resourceCount, resources.records.length),
    ...(resources.records.length ? [exthNumber(EXTH.kf8UnknownCount, 0)] : []),
    ...(pkg.direction === 'rtl' ? [exthText(EXTH.writingMode, 'horizontal-rl'), exthText(EXTH.pageDirection, 'rtl')] : []),
    exthText(EXTH.overrideFonts, 'true'),
  ]);
  const title = utf8(ctx.item.title.trim() || 'Untitled');
  const language = typeof ctx.item.metadata.language === 'string' ? ctx.item.metadata.language : undefined;
  const header = [
    ...u16(PALMDOC), ...u16(0), ...u32(allText.length), ...u16(textRecs.length), ...u16(TEXT_RECORD_SIZE), ...u16(0), ...u16(0),
    ...ascii('MOBI'), ...u32(264), ...u32(2), ...u32(65001), ...u32((Math.random() * 0xffffffff) >>> 0), ...u32(8),
    ...u32(NULL_INDEX), ...u32(NULL_INDEX), ...repeat(8).flatMap(() => u32(NULL_INDEX)),
    ...u32(firstNonText), ...u32(280 + exth.length), ...u32(title.length), ...u32(languageCode(language)), ...u32(0), ...u32(0), ...u32(8),
    ...u32(firstResource), ...u32(0), ...u32(0), ...u32(0), ...u32(0),
    ...u32(0x50 | (resources.fonts.size ? 0x1000 : 0)), ...repeat(32), ...u32(NULL_INDEX),
    ...u32(NULL_INDEX), ...u32(0), ...u32(0), ...u32(0), ...repeat(8),
    ...u32(fdstRecord), ...u32(flows.length), ...u32(fcisRecord), ...u32(1), ...u32(flisRecord), ...u32(1), ...repeat(8),
    ...u32(NULL_INDEX), ...u32(0), ...repeat(8, 0xff),
    ...u32(toc.length ? 0b11 : 0b1), ...u32(ncxIndex), ...u32(chunkIndex), ...u32(skelIndex), ...u32(NULL_INDEX), ...u32(guideIndex),
    ...u32(NULL_INDEX), ...u32(0), ...u32(NULL_INDEX), ...u32(0),
  ];
  // Room after the name for Amazon's tools to add to, as kindlegen leaves.
  const record0 = concat([header, exth, title, new Uint8Array(8192)]);
  records[0] = concat([record0, padTo4(record0.length)]);
  return palmDatabase(ctx.item.title, records);
}

interface FlatEntry extends TocEntry {
  label: string;
  posFid: [number, number];
  firstChild?: number;
  lastChild?: number;
}

/** The table of contents as KF8's index: depth first, then ordered by depth and position, each entry's extent to the next at its depth or above. */
function tocEntries(
  toc: TocNode[],
  locate: (path: string, fragment?: string) => { offset: number; posFid: [number, number] } | undefined,
  table: TableChunk[],
  textLength: number,
): FlatEntry[] {
  type Raw = { id: number; label: string; depth: number; parent?: number; children: number[]; offset: number; posFid: [number, number] };
  const raw: Raw[] = [];
  const walk = (nodes: TocNode[], depth: number, parent?: number) => {
    for (const node of nodes) {
      const located = locate(node.path, node.fragment);
      const entry: Raw = {
        id: raw.length,
        label: node.label,
        depth,
        ...(parent !== undefined && { parent }),
        children: [],
        offset: located?.offset ?? table[0]?.insertAt ?? 0,
        posFid: located?.posFid ?? [0, 0],
      };
      raw.push(entry);
      if (parent !== undefined) raw[parent]!.children.push(entry.id);
      walk(node.children, depth + 1, entry.id);
    }
  };
  walk(toc, 0);
  const sorted = [...raw].sort((a, b) => a.depth - b.depth || a.offset - b.offset || a.id - b.id);
  const indexOf = new Map(sorted.map((e, i) => [e.id, i]));
  return sorted.map((e, index) => {
    const next = sorted.filter((o) => o.depth <= e.depth && o.offset > e.offset).reduce((min, o) => Math.min(min, o.offset), textLength);
    const children = e.children.map((c) => indexOf.get(c)!);
    return {
      index,
      label: e.label,
      depth: e.depth,
      offset: e.offset,
      length: next - e.offset,
      posFid: e.posFid,
      ...(e.parent !== undefined && { parent: indexOf.get(e.parent)! }),
      ...(children.length && { firstChild: children[0]!, lastChild: children.at(-1)! }),
    };
  });
}
