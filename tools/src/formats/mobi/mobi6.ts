import type { ConvertContext } from '../convert/bookFromItem';
import { coverRecords, creatorRecords, EXTH, gatherResources, languageCode, metadataRecords } from './book';
import { Cascade, documentRules, fontScale, toEms, type CssRule } from './css';
import { fragmentOf, isExternal, resolveHref, type EpubPackage, type TocNode } from './epub';
import { ByteWriter, elements, escapeAttribute, escapeText, lonelySvgImage, removeComments, svgImageHref } from './markup';
import {
  ascii,
  concat,
  EOF_RECORD,
  exthBlock,
  exthNumber,
  exthText,
  FLIS,
  hexName,
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
  type IndexTag,
} from './records';
import { mobi6Tbs, type TocEntry } from './tbs';

/**
 * MOBI 6, the format every Kindle reads: the whole book as one HTML document in the
 * Mobipocket dialect (HTML 3 with `<mbp:pagebreak/>`), links as byte offsets into it
 * (`filepos`), images by record number (`recindex`). It has no CSS, so what the book's CSS
 * says that this markup can say is turned into it first: italic, bold, underline and
 * strikethrough as tags, sizes as `<font size>`, alignment as `align`, first-line indents
 * as `width` and space above blocks as `height`, page breaks, and hidden elements left out.
 * Calibre's MOBI writer (`ebooks/mobi/writer2`) documents the layout.
 */

const XHTML_NS = 'http://www.w3.org/1999/xhtml';

/** Elements left out with their content. */
const DROPPED = new Set(['script', 'style', 'link', 'meta', 'title', 'head', 'template', 'colgroup', 'col', 'rp', 'input', 'select', 'textarea', 'source', 'track', 'param', 'math', 'map', 'area']);
/** Elements replaced by their content. */
const UNWRAPPED = new Set(['thead', 'tbody', 'tfoot', 'noscript', 'object', 'embed', 'iframe', 'video', 'audio', 'canvas', 'ruby', 'rb', 'picture', 'button', 'label', 'form', 'fieldset', 'legend', 'abbr', 'acronym', 'bdi', 'bdo', 'data', 'time', 'mark', 'kbd', 'samp', 'code', 'tt', 'wbr']);
/** HTML 5's blocks, which the Mobipocket dialect knows only as `div`. */
const DIVS = new Set(['section', 'article', 'aside', 'header', 'footer', 'nav', 'main', 'figure', 'figcaption', 'hgroup', 'details', 'summary', 'address']);
const BLOCKS = new Set(['p', 'div', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'li', 'dt', 'dd', 'center', 'pre', 'ul', 'ol', 'dl', 'table', 'hr', ...DIVS]);
/** Blocks of text, which take a first-line indent. */
const PARAGRAPHS = new Set(['p', 'div', ...DIVS]);
const ITALIC = new Set(['i', 'em', 'cite', 'var', 'dfn', 'address']);
const BOLD = new Set(['b', 'strong', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'th']);
const UNDERLINE = new Set(['u', 'ins']);
const STRIKE = new Set(['s', 'strike', 'del']);
/** The attributes kept, by element (`*` for all). */
const KEPT: Record<string, string[]> = {
  '*': ['id', 'align'],
  a: ['href'],
  img: ['src', 'alt', 'width', 'height'],
  hr: ['width', 'size'],
  table: ['width', 'border', 'cellpadding', 'cellspacing'],
  td: ['colspan', 'rowspan', 'valign', 'width'],
  th: ['colspan', 'rowspan', 'valign', 'width'],
  ol: ['start', 'type'],
  ul: ['type'],
  li: ['value', 'type'],
  font: ['size', 'color', 'face'],
};

interface Style {
  italic: boolean;
  bold: boolean;
  underline: boolean;
  strike: boolean;
  align?: string;
  indent?: string;
  pre: boolean;
}

/** A length as Mobipocket writes them: points under a line's height (12pt), else ems, as Calibre does. */
function measure(ems: number): string {
  const points = Math.round(ems * 12);
  return points === 0 ? '0' : Math.abs(points) < 12 ? `${points}pt` : `${Math.round(ems)}em`;
}

const isBreak = (value: string | undefined) => value === 'always' || value === 'page' || value === 'left' || value === 'right';

function rename(el: Element, name: string): Element {
  const replacement = el.ownerDocument.createElementNS(XHTML_NS, name);
  for (const attr of Array.from(el.attributes)) replacement.setAttribute(attr.localName, attr.value);
  while (el.firstChild) replacement.appendChild(el.firstChild);
  el.replaceWith(replacement);
  return replacement;
}

function unwrap(el: Element) {
  el.replaceWith(...Array.from(el.childNodes));
}

/** Wraps an element's content in a new element. */
function wrapContent(el: Element, name: string, attributes: Record<string, string> = {}) {
  const wrapper = el.ownerDocument.createElementNS(XHTML_NS, name);
  for (const [k, v] of Object.entries(attributes)) wrapper.setAttribute(k, v);
  while (el.firstChild) wrapper.appendChild(el.firstChild);
  el.appendChild(wrapper);
}

/** Rewrites a document's body as Mobipocket markup, from what its CSS says. */
function mobiml(doc: Document, cascade: Cascade) {
  /** Converts an element, given the space below the block before it; returns the space below it. */
  const convert = (el: Element, parent: Style, spaceBefore: number): number => {
    const name = el.localName;
    if (name === 'a' && !el.hasAttribute('id') && el.getAttribute('name')) el.setAttribute('id', el.getAttribute('name')!);
    const display = cascade.get(el, 'display');
    if (DROPPED.has(name) || display === 'none' || cascade.get(el, 'visibility') === 'hidden') {
      el.remove();
      return spaceBefore;
    }
    if (name === 'svg') {
      const image = lonelySvgImage(el);
      const href = image && svgImageHref(image);
      if (!href) {
        el.remove();
        return spaceBefore;
      }
      const img = doc.createElementNS(XHTML_NS, 'img');
      img.setAttribute('src', href);
      el.replaceWith(img);
      return 0;
    }

    const flag = (property: string, on: (v: string) => boolean, off: (v: string) => boolean, tags: Set<string>, inherited: boolean) => {
      const value = cascade.get(el, property);
      if (value && on(value)) return true;
      if (value && off(value)) return false;
      return tags.has(name) || inherited;
    };
    // A decoration set on an element replaces its tag's own; its parents' still show through.
    const decoration = cascade.get(el, 'text-decoration');
    const decorated = (line: string, tags: Set<string>, inherited: boolean) => (decoration ? decoration.includes(line) : tags.has(name)) || inherited;
    const style: Style = {
      italic: flag('font-style', (v) => v === 'italic' || v === 'oblique', (v) => v === 'normal', ITALIC, parent.italic),
      bold: flag('font-weight', (v) => v === 'bold' || v === 'bolder' || parseInt(v) >= 600, (v) => v === 'normal' || v === 'lighter' || parseInt(v) < 600, BOLD, parent.bold),
      underline: decorated('underline', UNDERLINE, parent.underline),
      strike: decorated('line-through', STRIKE, parent.strike),
      pre: name === 'pre' || parent.pre || (cascade.get(el, 'white-space') ?? '').startsWith('pre'),
    };
    const align = cascade.get(el, 'text-align');
    const effectiveAlign = align === 'start' ? 'left' : align === 'end' ? 'right' : (align ?? parent.align);
    if (effectiveAlign) style.align = effectiveAlign;
    const indent = cascade.get(el, 'text-indent');
    const indentEms = indent === undefined ? undefined : toEms(indent);
    const effectiveIndent = indentEms !== undefined && indentEms >= 0 ? measure(indentEms) : parent.indent;
    if (effectiveIndent !== undefined) style.indent = effectiveIndent;

    let below = 0;
    for (const child of [...el.childNodes]) {
      if (child.nodeType === 1) below = convert(child as Element, style, below);
      else if (child.nodeType === 3) {
        if (!style.pre) child.nodeValue = (child.nodeValue ?? '').replace(/[ \t\r\n]+/g, ' ');
        if (child.nodeValue?.trim()) below = 0;
      } else child.remove();
    }

    // Formatting the element's own tag doesn't give, as tags around its content.
    const own = (on: boolean, inherited: boolean, tags: Set<string>) => on && !inherited && !tags.has(name);
    const size = /^h[1-6]$/.test(name) ? undefined : fontScale(cascade.get(el, 'font-size'));
    if (size !== undefined && (size <= 0.9 || size >= 1.15)) {
      wrapContent(el, 'font', { size: size <= 0.75 ? '-2' : size <= 0.9 ? '-1' : size < 1.4 ? '+1' : size < 1.8 ? '+2' : '+3' });
    }
    const vertical = cascade.get(el, 'vertical-align');
    if ((vertical === 'super' || vertical === 'sub') && name !== 'sup' && name !== 'sub' && !BLOCKS.has(name)) wrapContent(el, vertical === 'super' ? 'sup' : 'sub');
    if (own(style.strike, parent.strike, STRIKE)) wrapContent(el, 'strike');
    if (own(style.underline, parent.underline, UNDERLINE)) wrapContent(el, 'u');
    if (own(style.bold, parent.bold, BOLD)) wrapContent(el, 'b');
    if (own(style.italic, parent.italic, ITALIC)) wrapContent(el, 'i');

    const block = BLOCKS.has(name);
    if (block && style.align && ['center', 'right', 'justify'].includes(style.align)) el.setAttribute('align', style.align);
    else if (block && style.align === 'left' && parent.align && parent.align !== 'left') el.setAttribute('align', 'left');
    if (PARAGRAPHS.has(name) && style.indent !== undefined) el.setAttribute('width', style.indent);
    // Space above a block: its own top margin, or the bottom margin of the block before, whichever is more, as margins collapse.
    const margin = (property: string) => Math.max(toEms(cascade.get(el, property)) ?? 0, 0);
    if (block) {
      const space = Math.max(margin('margin-top') + margin('padding-top'), spaceBefore);
      if (space >= 0.25 && name !== 'hr') el.setAttribute('height', measure(space));
    }

    const pageBreak = () => doc.createElementNS('http://mobipocket.com/ns/mbp', 'mbp:pagebreak');
    if (isBreak(cascade.get(el, 'page-break-before'))) el.before(pageBreak());
    if (isBreak(cascade.get(el, 'page-break-after'))) el.after(pageBreak());

    let result: Element = el;
    if (DIVS.has(name)) result = rename(el, 'div');
    else if (name === 'em' || name === 'cite' || name === 'var' || name === 'dfn') result = rename(el, style.italic ? 'i' : 'span');
    else if (name === 'i' && !style.italic) result = rename(el, 'span');
    else if (name === 'strong') result = rename(el, style.bold ? 'b' : 'span');
    else if (name === 'b' && !style.bold) result = rename(el, 'span');
    else if (name === 'ins' || name === 'u') result = rename(el, style.underline ? 'u' : 'span');
    else if (name === 's' || name === 'del' || name === 'strike') result = rename(el, style.strike ? 'strike' : 'span');
    else if (name === 'rt') {
      el.prepend('(');
      el.append(')');
      unwrap(el);
      return 0;
    } else if (name === 'q') {
      el.prepend('“');
      el.append('”');
      unwrap(el);
      return 0;
    } else if (name === 'small' || name === 'big') {
      result = rename(el, 'font');
      result.setAttribute('size', name === 'small' ? '-1' : '+1');
    } else if (UNWRAPPED.has(name)) {
      unwrap(el);
      return 0;
    }
    const kept = new Set([...KEPT['*']!, ...(KEPT[result.localName] ?? []), 'height', 'width']);
    for (const attr of Array.from(result.attributes)) {
      if (!kept.has(attr.localName) || (attr.localName === 'width' && !PARAGRAPHS.has(result.localName) && !KEPT[result.localName]?.includes('width'))) {
        result.removeAttributeNode(attr);
      }
    }
    return block ? margin('margin-bottom') + margin('padding-bottom') : 0;
  };
  const body = elements(doc, 'body')[0];
  let below = 0;
  const top: Style = { italic: false, bold: false, underline: false, strike: false, pre: false };
  if (body) for (const child of [...body.children]) below = convert(child, top, below);
}

const fcis = (textLength: number) =>
  concat([ascii('FCIS'), u32(0x14), u32(0x10), u32(1), u32(0), u32(textLength), u32(0), u32(0x20), u32(8), u16(1), u16(1), u32(0)]);

const NCX_TAGS: IndexTag[] = [
  { name: 'offset', number: 1, valuesPerEntry: 1, mask: 1 },
  { name: 'length', number: 2, valuesPerEntry: 1, mask: 2 },
  { name: 'label', number: 3, valuesPerEntry: 1, mask: 4 },
  { name: 'depth', number: 4, valuesPerEntry: 1, mask: 8 },
];

/** Where the contents page written for books without one is, among the offsets. */
const CONTENTS = '#nexlibris-contents';

/** Kindles apply `@media amzn-mobi` to MOBI 6 and `amzn-kf8` to KF8. */
const MOBI_MEDIA = (query: string) => !/amzn-kf8|^\s*print\s*$/i.test(query) && (/amzn-mobi|all|screen/i.test(query) || !/amzn-/i.test(query));

/** Placeholder digits for a link's offset, filled in once every target's offset is known. */
const FILEPOS = '0000000000';

/** The book as MOBI 6. */
export async function writeMobi6(pkg: EpubPackage, ctx: ConvertContext): Promise<Blob> {
  const docs: { path: string; doc: Document }[] = [];
  const cssCache = new Map<string, CssRule[]>();
  for (const item of pkg.spine) {
    const doc = await pkg.document(item.path);
    const body = doc && elements(doc, 'body')[0];
    if (!doc || !body) continue;
    removeComments(doc.documentElement);
    mobiml(doc, new Cascade(doc, await documentRules(pkg, item.path, doc, cssCache, MOBI_MEDIA)));
    docs.push({ path: item.path, doc });
  }

  const imagePaths = docs.flatMap(({ path, doc }) =>
    elements(doc, 'img').flatMap((img) => {
      const src = img.getAttribute('src');
      return src && !isExternal(src) && !src.startsWith('data:') ? [resolveHref(path, src)] : [];
    }),
  );
  const resources = await gatherResources(pkg, ctx, imagePaths);
  const spinePaths = new Set(docs.map((d) => d.path));

  // The book as one document, recording where each file and id starts and where each link's offset goes.
  const out = new ByteWriter();
  const offsets = new Map<string, number>();
  const links: { at: number; target: string }[] = [];
  /** Where the run of tags just opened began, so a link lands before them rather than inside. */
  let anchorAt: number | undefined;
  const writeNode = (node: Node, path: string, pre: boolean) => {
    if (node.nodeType === 3) {
      let text = escapeText((node.nodeValue ?? '').replace(/­/g, '').normalize('NFC'));
      if (!text) return;
      if (text.trim()) anchorAt = undefined;
      if (pre) {
        text = text.replace(/ /g, ' ').replace(/\r\n?/g, '\n').replace(/\n/g, '<br></br>');
      }
      out.write(text);
      return;
    }
    if (node.nodeType !== 1) return;
    const el = node as Element;
    const name = el.localName === 'pagebreak' ? 'mbp:pagebreak' : el.localName;
    const id = el.getAttribute('id');
    if (id && !offsets.has(`${path}#${id}`)) offsets.set(`${path}#${id}`, anchorAt ?? out.length);
    if (name === 'mbp:pagebreak') {
      out.write('<mbp:pagebreak/>');
      return;
    }
    // An empty anchor only marks a place, which its id has recorded.
    if (name === 'a' && !el.getAttribute('href') && !el.childNodes.length) return;
    // An image the book can't show is its description.
    const src = name === 'img' ? el.getAttribute('src') : null;
    const image = src ? resources.images.get(resolveHref(path, src)) : undefined;
    if (name === 'img' && !image) {
      const alt = el.getAttribute('alt')?.trim();
      if (alt) out.write(escapeText(alt));
      return;
    }
    anchorAt ??= out.length;
    out.write(`<${name}`);
    for (const attr of Array.from(el.attributes)) {
      if (attr.localName === 'id') continue;
      if (name === 'a' && attr.localName === 'href') {
        const href = attr.value;
        if (isExternal(href)) {
          out.write(` href="${escapeAttribute(href)}"`);
          continue;
        }
        const targetPath = href.startsWith('#') ? path : resolveHref(path, href);
        if (!spinePaths.has(targetPath)) continue;
        const fragment = fragmentOf(href);
        out.write(' filepos=');
        links.push({ at: out.length, target: `${targetPath}#${fragment ?? ''}` });
        out.write(FILEPOS);
        continue;
      }
      if (name === 'img' && attr.localName === 'src') {
        out.write(` recindex="${String(image!.index).padStart(5, '0')}"`);
        continue;
      }
      out.write(` ${attr.localName}="${escapeAttribute(attr.value)}"`);
    }
    out.write('>');
    for (const child of el.childNodes) writeNode(child, path, pre || name === 'pre');
    out.write(`</${name}>`);
  };

  out.write('<html><head>');
  const guide = pkg.landmarks.filter((l) => spinePaths.has(l.path));
  // A contents page at the end where the book names none, as Calibre adds: older Kindles' Go to Contents opens it.
  const contentsPage = pkg.toc.length > 0 && !guide.some((g) => g.type === 'toc');
  const references = [
    ...guide.map((ref) => ({ type: ref.type.replace(/^other\./, ''), title: ref.title, target: `${ref.path}#${ref.fragment ?? ''}` })),
    ...(contentsPage ? [{ type: 'toc', title: 'Contents', target: CONTENTS }] : []),
  ];
  if (references.length) {
    out.write('<guide>');
    for (const ref of references) {
      out.write(`<reference type="${escapeAttribute(ref.type)}" title="${escapeAttribute(ref.title)}" filepos=`);
      links.push({ at: out.length, target: ref.target });
      // The space before the slash is needed, Calibre found.
      out.write(`${FILEPOS} />`);
    }
    out.write('</guide>');
  }
  out.write('</head><body>');
  const bodyStart = out.length;
  for (const { path, doc } of docs) {
    offsets.set(`${path}#`, out.length);
    anchorAt = undefined;
    for (const child of elements(doc, 'body')[0]!.childNodes) writeNode(child, path, false);
    out.write('<mbp:pagebreak/>');
  }
  const bodyEnd = out.length;
  if (contentsPage) {
    offsets.set(CONTENTS, out.length);
    out.write('<h2 height="2em">Contents</h2>');
    const writeEntries = (nodes: TocNode[]) => {
      for (const node of nodes) {
        out.write('<p height="1em"><a filepos=');
        links.push({ at: out.length, target: `${node.path}#${node.fragment ?? ''}` });
        out.write(`${FILEPOS}>${escapeText(node.label)}</a></p>`);
        if (node.children.length) {
          out.write('<blockquote>');
          writeEntries(node.children);
          out.write('</blockquote>');
        }
      }
    };
    writeEntries(pkg.toc);
    out.write('<mbp:pagebreak/>');
  }
  out.write('</body></html>');

  const text = out.bytes();
  const offsetOf = (target: string) => offsets.get(target) ?? offsets.get(`${target.split('#')[0]}#`);
  for (const link of links) {
    const offset = offsetOf(link.target);
    if (offset !== undefined) text.set(new TextEncoder().encode(String(offset).padStart(10, '0')), link.at);
  }
  const start = guide.find((g) => g.type === 'text' || g.type === 'start' || g.title.toLowerCase() === 'start');
  const startReading = (start && offsetOf(`${start.path}#${start.fragment ?? ''}`)) ?? bodyStart;

  const { records: textRecs, lengths } = textRecords(text);
  const toc = flatToc(pkg.toc, offsetOf, bodyEnd);
  if (toc.length) {
    const tbs = mobi6Tbs(toc, lengths);
    for (const [i, sequence] of tbs.entries()) textRecs[i] = concat([textRecs[i]!, trailingEntry(sequence)]);
  }

  const records: Uint8Array[] = [new Uint8Array(0), ...textRecs];
  const textSize = textRecs.reduce((n, r) => n + r.length, 0);
  if (textSize % 4) records.push(new Uint8Array(textSize % 4));
  const firstNonText = records.length;
  let primaryIndex = NULL_INDEX;
  if (toc.length) {
    const strings = new Strings(toc.map((e) => e.label));
    primaryIndex = records.length;
    records.push(
      ...indexRecords(
        NCX_TAGS,
        toc.map((e) => ({ name: hexName(e.index), values: { offset: e.offset, length: e.length, label: strings.offset(e.label), depth: 0 } })),
        strings,
      ),
    );
  }
  const firstImage = records.length;
  records.push(...resources.records);
  const lastContent = records.length - 1;
  const flisRecord = records.length;
  records.push(FLIS);
  const fcisRecord = records.length;
  records.push(fcis(text.length));
  records.push(EOF_RECORD);

  const exth = exthBlock([
    ...metadataRecords(ctx),
    ...creatorRecords(false),
    ...coverRecords(resources, false),
    exthNumber(EXTH.startReading, startReading),
    exthText(EXTH.overrideFonts, 'true'),
  ]);
  const title = new TextEncoder().encode((ctx.item.title.trim() || 'Untitled').normalize('NFC'));
  const language = typeof ctx.item.metadata.language === 'string' ? ctx.item.metadata.language : undefined;
  const header = [
    ...u16(PALMDOC), ...u16(0), ...u32(text.length), ...u16(textRecs.length), ...u16(TEXT_RECORD_SIZE), ...u16(0), ...u16(0),
    ...ascii('MOBI'), ...u32(0xe8), ...u32(2), ...u32(65001), ...u32((Math.random() * 0xffffffff) >>> 0), ...u32(6),
    ...repeat(8, 0xff), ...u32(NULL_INDEX), ...repeat(28, 0xff),
    ...u32(firstNonText), ...u32(0xe8 + 16 + exth.length), ...u32(title.length), ...u32(languageCode(language)), ...repeat(8),
    ...u32(6), ...u32(resources.records.length ? firstImage : records.length), ...repeat(16),
    ...u32(0x50), ...repeat(32),
    ...u32(NULL_INDEX), ...u32(NULL_INDEX), ...u32(0), ...u32(0), ...repeat(12),
    ...u16(1), ...u16(lastContent), ...u32(1),
    ...u32(fcisRecord), ...u32(1), ...u32(flisRecord), ...u32(1), ...repeat(8),
    ...u32(NULL_INDEX), ...u32(0), ...u32(NULL_INDEX), ...u32(NULL_INDEX),
    ...u32(toc.length ? 0b11 : 0b1), ...u32(primaryIndex),
  ];
  const record0 = concat([header, exth, title, new Uint8Array(8192)]);
  records[0] = concat([record0, padTo4(record0.length)]);
  return palmDatabase(ctx.item.title, records);
}

interface FlatEntry extends TocEntry {
  label: string;
}

/** The table of contents flattened, as MOBI 6 books' are: by position, one entry per place, each running to the next. */
function flatToc(toc: TocNode[], offsetOf: (target: string) => number | undefined, end: number): FlatEntry[] {
  const seen = new Set<number>();
  const entries: { label: string; offset: number }[] = [];
  const walk = (nodes: TocNode[]) => {
    for (const node of nodes) {
      const offset = offsetOf(`${node.path}#${node.fragment ?? ''}`);
      if (offset !== undefined && !seen.has(offset)) {
        seen.add(offset);
        entries.push({ label: node.label, offset });
      }
      walk(node.children);
    }
  };
  walk(toc);
  entries.sort((a, b) => a.offset - b.offset);
  const kept = entries.filter((e, i) => (entries[i + 1]?.offset ?? end) > e.offset);
  return kept.map((e, index) => ({ index, label: e.label, offset: e.offset, length: (kept[index + 1]?.offset ?? end) - e.offset, depth: 0 }));
}
