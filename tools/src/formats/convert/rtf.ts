import { languageCode } from '../mobi/book';
import { Cascade, documentRules, fontScale, toEms } from '../mobi/css';
import { fragmentOf, isExternal, readEpubPackage, resolveHref } from '../mobi/epub';
import { elements, lonelySvgImage, removeComments, svgImageHref } from '../mobi/markup';
import { hasCanvas, imageType, redraw } from '../mobi/resources';
import type { ConvertContext } from './bookFromItem';

/**
 * An EPUB as Rich Text, which word processors open: each chapter from a new page, headings as
 * Word's heading styles (so they make its navigation pane and a table of contents), what the CSS
 * says of type (italic, bold, underline, strikethrough, small capitals, sizes), alignment, indents
 * and spacing, lists, tables, images (PNG and JPEG as they are, others redrawn as PNG where there's
 * a canvas), and links: to the web as hyperlinks, within the book to bookmarks. The metadata is the
 * library's, in the `\info` group (`parseRtf` reads it back), and its cover the first page.
 */

/** Twips (1/20 point) per em of the body's 12-point text. */
const EM = 240;
/** The text's width on a Letter page with inch margins, and its height, in twips. */
const PAGE_WIDTH = 9360;
const PAGE_HEIGHT = 12960;
/** Twips per CSS pixel. */
const PX = 15;
/** Headings' sizes, in half points. */
const HEADING_SIZES = [36, 32, 28, 24, 24, 24];

const DROPPED = new Set(['script', 'style', 'link', 'meta', 'title', 'head', 'template', 'rp', 'input', 'select', 'textarea', 'button', 'source', 'track', 'math', 'colgroup', 'col']);
const BLOCKS = new Set(['p', 'div', 'section', 'article', 'aside', 'header', 'footer', 'nav', 'main', 'figure', 'figcaption', 'hgroup', 'details', 'summary', 'address', 'center', 'blockquote', 'pre', 'dl', 'dt', 'dd', 'ul', 'ol', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'body']);
const ITALIC = new Set(['i', 'em', 'cite', 'var', 'dfn', 'address']);
const BOLD = new Set(['b', 'strong', 'th', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6']);
const MONO = new Set(['code', 'tt', 'kbd', 'samp', 'pre']);

/** Text as RTF writes it: its control characters escaped, the rest of ASCII as it is, everything else as `\u`. */
export function rtfText(text: string): string {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    const c = text[i]!;
    if (c === '\\' || c === '{' || c === '}') out += `\\${c}`;
    else if (c === '\t') out += '\\tab ';
    else if (c === '\u00a0') out += '\\~';
    else if (c === '\u00ad') out += '\\-';
    else if (code >= 0x20 && code < 0x80) out += c;
    else if (code >= 0x80) out += `\\u${code > 0x7fff ? code - 0x10000 : code}?`;
  }
  return out;
}

/** A picture's pixel size, from a PNG's header or a JPEG's frame. */
export function imageSize(bytes: Uint8Array): { width: number; height: number } | undefined {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (imageType(bytes) === 'image/png' && bytes.length >= 24) return { width: view.getUint32(16), height: view.getUint32(20) };
  for (let at = 2; at + 9 < bytes.length && bytes[at] === 0xff; ) {
    const marker = bytes[at + 1]!;
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { width: view.getUint16(at + 7), height: view.getUint16(at + 5) };
    }
    at += 2 + view.getUint16(at + 2);
  }
  return undefined;
}

interface Picture {
  data: Uint8Array;
  type: 'image/png' | 'image/jpeg';
  width: number;
  height: number;
}

/** An image as RTF holds one, PNG or JPEG, or undefined where it can't be made one. */
async function picture(bytes: Uint8Array, declared: string): Promise<Picture | undefined> {
  let type = imageType(bytes, declared);
  let data = bytes;
  if (type !== 'image/png' && type !== 'image/jpeg') {
    if (!hasCanvas() || type === 'image/svg+xml') return undefined;
    try {
      data = await redraw(bytes, 'image/png', 1);
      type = 'image/png';
    } catch {
      return undefined;
    }
  }
  const size = imageSize(data);
  return size && { data, type: type as Picture['type'], ...size };
}

function pictureGroup(pic: Picture, cssWidth?: number): string {
  // Shown at 96 pixels an inch, or the width the CSS asks for, and no larger than the page.
  let width = (cssWidth ?? pic.width) * PX;
  let height = (pic.height / pic.width) * width;
  const scale = Math.min(1, PAGE_WIDTH / width, PAGE_HEIGHT / height);
  width = Math.round(width * scale);
  height = Math.round(height * scale);
  let hex = '';
  for (let i = 0; i < pic.data.length; i++) {
    hex += pic.data[i]!.toString(16).padStart(2, '0');
    if (i % 64 === 63) hex += '\n';
  }
  const blip = pic.type === 'image/png' ? '\\pngblip' : '\\jpegblip';
  return `{\\pict${blip}\\picw${pic.width}\\pich${pic.height}\\picwgoal${width}\\pichgoal${height}\n${hex}}`;
}

interface Inline {
  italic: boolean;
  bold: boolean;
  underline: boolean;
  strike: boolean;
  smallCaps: boolean;
  mono: boolean;
  vertical?: 'super' | 'sub';
  /** Half points. */
  size: number;
  link: boolean;
}

interface Block {
  align?: string;
  left: number;
  right: number;
  pre: boolean;
  listDepth: number;
  inCell: boolean;
}

const isBreak = (value: string | undefined) => value === 'always' || value === 'page' || value === 'left' || value === 'right';

/** The book as RTF. */
export async function epubToRtf(data: Blob, ctx: ConvertContext): Promise<Blob> {
  const pkg = await readEpubPackage(data);
  const docs: { path: string; doc: Document; cascade: Cascade }[] = [];
  const cssCache = new Map();
  // A word processor's page is printed, so `@media print` rules count and Kindles' don't.
  const media = (query: string) => !/amzn-/i.test(query);
  for (const item of pkg.spine) {
    const doc = await pkg.document(item.path);
    if (!doc || !elements(doc, 'body')[0]) continue;
    removeComments(doc.documentElement);
    docs.push({ path: item.path, doc, cascade: new Cascade(doc, await documentRules(pkg, item.path, doc, cssCache, media)) });
  }

  // Bookmarks for the places links go: a chapter's start, or an element's id.
  const bookmarks = new Map<string, string>();
  const spinePaths = new Set(docs.map((d) => d.path));
  const linkTarget = (path: string, href: string) => {
    const target = href.startsWith('#') ? path : resolveHref(path, href);
    return spinePaths.has(target) ? `${target}#${fragmentOf(href) ?? ''}` : undefined;
  };
  for (const { path, doc } of docs) {
    for (const a of elements(doc, 'a')) {
      const href = a.getAttribute('href');
      const target = href && !isExternal(href) ? linkTarget(path, href) : undefined;
      if (target && !bookmarks.has(target)) bookmarks.set(target, `_n${bookmarks.size + 1}`);
    }
  }

  const pictures = new Map<string, Picture | undefined>();
  const pictureAt = async (path: string) => {
    if (!pictures.has(path)) {
      const bytes = await pkg.read(path);
      pictures.set(path, bytes && (await picture(bytes, pkg.byPath.get(path)?.mediaType ?? '')));
    }
    return pictures.get(path);
  };

  const out: string[] = [];
  /** The open paragraph's properties, written when its first content is; undefined while none is open. */
  let pending: string | undefined;
  let open = false;
  let pageBreak = false;
  /** Whether the paragraph so far ends in a space (or is empty), so collapsed spaces aren't doubled. */
  let spaced = true;
  const startParagraph = (props: string) => {
    endParagraph();
    pending = props;
  };
  const write = (rtf: string) => {
    if (!open) {
      if (pending === undefined) pending = '\\pard\\plain\\sa120\\f0\\fs24';
      out.push(`${pending}${pageBreak ? '\\pagebb' : ''}\n`);
      pageBreak = false;
      open = true;
    }
    out.push(rtf);
  };
  const endParagraph = (end = '\\par') => {
    if (open) out.push(`${end}\n`);
    open = false;
    pending = undefined;
    spaced = true;
  };
  const bookmark = (target: string) => {
    const name = bookmarks.get(target);
    if (name) write(`{\\*\\bkmkstart ${name}}{\\*\\bkmkend ${name}}`);
  };

  const paragraphProps = (el: Element | undefined, block: Block, cascade: Cascade | undefined, heading?: number) => {
    const ems = (property: string) => (el && cascade ? toEms(cascade.get(el, property)) : undefined);
    const name = el?.localName ?? '';
    let props = '\\pard\\plain';
    if (heading) props += `\\s${heading}\\outlinelevel${heading - 1}\\keepn`;
    if (block.inCell) props += '\\intbl';
    if (pkg.direction === 'rtl') props += '\\rtlpar';
    const align = block.align === 'center' ? '\\qc' : block.align === 'right' || block.align === 'end' ? '\\qr' : block.align === 'justify' ? '\\qj' : '\\ql';
    props += align;
    const before = ems('margin-top') ?? (heading ? 1 : 0);
    const after = ems('margin-bottom') ?? (heading ? 0.5 : name === 'p' || name === 'li' || name === 'dd' || !name ? 0.5 : 0);
    if (before > 0) props += `\\sb${Math.round(before * EM)}`;
    if (after > 0) props += `\\sa${Math.round(after * EM)}`;
    const left = block.left + Math.max(0, Math.round((ems('margin-left') ?? 0) * EM));
    if (left) props += `\\li${left}`;
    if (block.right) props += `\\ri${block.right}`;
    const indent = ems('text-indent');
    if (indent) props += `\\fi${Math.round(indent * EM)}`;
    props += `\\f${block.pre ? 1 : 0}`;
    props += `\\fs${heading ? HEADING_SIZES[heading - 1] : 24}`;
    if (heading) props += '\\b';
    return props;
  };

  const runControls = (style: Inline) => {
    let c = '';
    if (style.italic) c += '\\i';
    if (style.bold) c += '\\b';
    if (style.underline || style.link) c += '\\ul';
    if (style.strike) c += '\\strike';
    if (style.smallCaps) c += '\\scaps';
    if (style.mono) c += '\\f1';
    if (style.vertical) c += style.vertical === 'super' ? '\\super' : '\\sub';
    if (style.link) c += '\\cf1';
    c += `\\fs${style.size}`;
    return c;
  };

  const text = (value: string, style: Inline, block: Block) => {
    let t = value;
    if (block.pre) {
      const lines = t.replace(/\r\n?/g, '\n').split('\n');
      const runs = lines.map((line) => rtfText(line));
      if (!t) return;
      write(`{${runControls(style)} ${runs.join('\\line ')}}`);
      return;
    }
    t = t.replace(/[ \t\r\n\f]+/g, ' ');
    if (spaced) t = t.replace(/^ /, '');
    if (!t) return;
    spaced = t.endsWith(' ');
    write(`{${runControls(style)} ${rtfText(t)}}`);
  };

  const inlineStyle = (el: Element, parent: Inline, cascade: Cascade): Inline => {
    const name = el.localName;
    const get = (p: string) => cascade.get(el, p);
    const style = { ...parent };
    const fontStyle = get('font-style');
    style.italic = fontStyle ? fontStyle === 'italic' || fontStyle === 'oblique' : ITALIC.has(name) || parent.italic;
    const weight = get('font-weight');
    style.bold = weight ? weight === 'bold' || weight === 'bolder' || parseInt(weight) >= 600 : BOLD.has(name) || parent.bold;
    const decoration = get('text-decoration');
    style.underline = (decoration ? decoration.includes('underline') : name === 'u' || name === 'ins') || parent.underline;
    style.strike = (decoration ? decoration.includes('line-through') : name === 's' || name === 'strike' || name === 'del') || parent.strike;
    const variant = get('font-variant');
    style.smallCaps = variant ? variant.includes('small-caps') : parent.smallCaps;
    style.mono = MONO.has(name) || /monospace|courier/.test(get('font-family') ?? '') || parent.mono;
    const vertical = get('vertical-align');
    if (name === 'sup' || vertical === 'super') style.vertical = 'super';
    else if (name === 'sub' || vertical === 'sub') style.vertical = 'sub';
    else if (vertical === 'baseline') delete style.vertical;
    const scale = fontScale(get('font-size'));
    if (scale !== undefined && !/^h[1-6]$/.test(name)) style.size = Math.max(8, Math.round(parent.size * scale));
    else if (name === 'small') style.size = Math.round(parent.size * 0.83);
    else if (name === 'big') style.size = Math.round(parent.size * 1.2);
    if (style.vertical && name !== 'sup' && name !== 'sub' && scale === undefined) style.size = parent.size;
    return style;
  };

  const image = async (path: string, src: string | null | undefined, alt: string | null, el: Element, cascade: Cascade, style: Inline, block: Block) => {
    const pic = src && !isExternal(src) && !src.startsWith('data:') ? await pictureAt(resolveHref(path, src)) : undefined;
    if (!pic) {
      if (alt?.trim()) text(`[${alt.trim()}]`, style, block);
      return;
    }
    const width = cascade.get(el, 'width');
    const cssWidth = width?.endsWith('%') ? (parseFloat(width) / 100) * (PAGE_WIDTH / PX) : width?.endsWith('px') ? parseFloat(width) : el.getAttribute('width') && /^\d+$/.test(el.getAttribute('width')!) ? Number(el.getAttribute('width')) : undefined;
    write(pictureGroup(pic, cssWidth));
    spaced = false;
  };

  const table = async (el: Element, path: string, cascade: Cascade, style: Inline, block: Block) => {
    endParagraph();
    const rows = elements(el, 'tr').filter((tr) => tr.closest('table') === el);
    for (const tr of rows) {
      const cells = Array.from(tr.children).filter((c) => c.localName === 'td' || c.localName === 'th');
      if (!cells.length) continue;
      const span = (c: Element) => Math.max(1, Number(c.getAttribute('colspan')) || 1);
      const columns = cells.reduce((n, c) => n + span(c), 0);
      let edge = block.left;
      let row = `\\trowd\\trgaph108\\trleft${block.left}`;
      for (const cell of cells) {
        edge += Math.round(((PAGE_WIDTH - block.left) * span(cell)) / columns);
        row += `\\clbrdrt\\brdrs\\brdrw10\\clbrdrl\\brdrs\\brdrw10\\clbrdrb\\brdrs\\brdrw10\\clbrdrr\\brdrs\\brdrw10\\cellx${edge}`;
      }
      out.push(`${row}\n`);
      for (const cell of cells) {
        const inner: Block = { ...block, left: 0, right: 0, inCell: true, align: cascade.get(cell, 'text-align') ?? (cell.localName === 'th' ? 'center' : block.align) };
        pending = paragraphProps(undefined, inner, undefined);
        await children(cell, path, cascade, inlineStyle(cell, style, cascade), inner);
        if (open) endParagraph('\\cell');
        else out.push(`${paragraphProps(undefined, inner, undefined)}\\cell\n`);
        pending = undefined;
      }
      out.push(`${row}\\row\n`);
    }
    out.push('\\pard\\plain\n');
  };

  const children = async (el: Element, path: string, cascade: Cascade, style: Inline, block: Block) => {
    let number = Number(el.getAttribute('start')) || 1;
    for (const child of Array.from(el.childNodes)) {
      if (child.nodeType === 3) text(child.nodeValue ?? '', style, block);
      else if (child.nodeType === 1) {
        const c = child as Element;
        let marker: string | undefined;
        if (c.localName === 'li') {
          const value = Number(c.getAttribute('value'));
          if (value) number = value;
          const listStyle = cascade.get(c, 'list-style-type') ?? cascade.get(el, 'list-style-type') ?? cascade.get(el, 'list-style');
          marker = listStyle?.includes('none') ? '' : el.localName === 'ol' ? `${number++}.` : '\u2022';
        }
        await node(c, path, cascade, style, block, marker);
      }
    }
  };

  const node = async (el: Element, path: string, cascade: Cascade, parent: Inline, block: Block, marker?: string) => {
    const name = el.localName;
    if (DROPPED.has(name) || cascade.get(el, 'display') === 'none' || cascade.get(el, 'visibility') === 'hidden') return;
    const id = el.getAttribute('id') ?? (name === 'a' ? el.getAttribute('name') : null);
    const target = id ? `${path}#${id}` : undefined;
    const style = inlineStyle(el, parent, cascade);

    if (name === 'br') {
      write('\\line ');
      spaced = true;
      return;
    }
    if (name === 'img') return image(path, el.getAttribute('src'), el.getAttribute('alt'), el, cascade, style, block);
    if (name === 'svg') {
      const inner = lonelySvgImage(el);
      if (inner) await image(path, svgImageHref(inner), el.querySelector('title')?.textContent ?? null, el, cascade, style, block);
      return;
    }
    if (name === 'table') {
      if (block.inCell) {
        // A table in a cell, its cells' text in a line.
        for (const cell of elements(el).filter((c) => c.localName === 'td' || c.localName === 'th')) {
          await children(cell, path, cascade, style, block);
          text(' ', style, block);
        }
        return;
      }
      if (target) bookmark(target);
      await table(el, path, cascade, style, block);
      return;
    }
    if (name === 'hr') {
      endParagraph();
      out.push(`\\pard\\plain${block.inCell ? '\\intbl' : ''}\\sb120\\sa120\\brdrb\\brdrs\\brdrw10\\brsp20\\fs4\\par\n`);
      return;
    }
    if (name === 'rt') {
      text(' (', style, block);
      await children(el, path, cascade, style, block);
      text(')', style, block);
      return;
    }

    const display = cascade.get(el, 'display');
    const isBlock = display ? display === 'block' || display === 'list-item' || display === 'table' : BLOCKS.has(name);
    if (!isBlock) {
      if (target) bookmark(target);
      const href = name === 'a' ? el.getAttribute('href') : null;
      const internal = href && !isExternal(href) ? linkTarget(path, href) : undefined;
      const url = href && isExternal(href) && /^(https?|mailto|ftp):/i.test(href) ? href : undefined;
      if (url || (internal && bookmarks.has(internal))) {
        const instruction = url ? `HYPERLINK "${url.replace(/["\\]/g, '\\$&')}"` : `HYPERLINK \\l "${bookmarks.get(internal!)}"`;
        write(`{\\field{\\*\\fldinst{${rtfText(instruction)}}}{\\fldrslt{`);
        const length = out.length;
        await children(el, path, cascade, { ...style, link: true }, block);
        // A field needs a result to show; a link around nothing shows its address.
        if (out.length === length) text(url ?? '\u2192', { ...style, link: true }, block);
        out.push('}}}');
        return;
      }
      await children(el, path, cascade, style, block);
      return;
    }

    // A block: its own paragraph, and a paragraph after it for what follows.
    const heading = /^h([1-6])$/.exec(name);
    if (heading && fontScale(cascade.get(el, 'font-size')) === undefined) style.size = HEADING_SIZES[Number(heading[1]) - 1]!;
    const inner: Block = { ...block };
    const align = cascade.get(el, 'text-align');
    if (align) inner.align = align === 'start' ? 'left' : align;
    else if (name === 'center') inner.align = 'center';
    if (name === 'blockquote') {
      inner.left += 720;
      inner.right += 720;
    }
    if (name === 'dd') inner.left += 720;
    if (name === 'ul' || name === 'ol') inner.listDepth++;
    if (name === 'pre' || (cascade.get(el, 'white-space') ?? '').startsWith('pre')) inner.pre = true;
    if (isBreak(cascade.get(el, 'page-break-before')) && !block.inCell) pageBreak = true;
    if (marker !== undefined) {
      inner.left = block.left + 360 * Math.max(1, block.listDepth);
      startParagraph(`${paragraphProps(el, inner, cascade)}\\fi-360\\tx${inner.left}`);
      write(marker ? `${rtfText(marker)}\\tab ` : '');
    } else {
      startParagraph(paragraphProps(el, inner, cascade, heading ? Number(heading[1]) : undefined));
    }
    if (target) bookmark(target);
    await children(el, path, cascade, style, inner);
    endParagraph();
    if (isBreak(cascade.get(el, 'page-break-after')) && !block.inCell) pageBreak = true;
  };

  // The library's cover first, in place of the book's own cover page.
  const coverPage = (doc: Document) => {
    const body = elements(doc, 'body')[0]!;
    if (body.textContent?.trim()) return false;
    const images = elements(body).filter((e) => e.localName === 'img' || e.localName === 'image');
    return images.length === 1;
  };
  let first = true;
  if (ctx.cover) {
    const pic = await picture(new Uint8Array(await ctx.cover.data.arrayBuffer()), ctx.cover.mediaType);
    if (pic) {
      out.push('\\pard\\plain\\qc\n');
      out.push(pictureGroup({ ...pic, width: pic.width, height: pic.height }, Math.min(pic.width, PAGE_WIDTH / PX)));
      out.push('\\par\n');
      first = false;
    }
  }
  const top: Inline = { italic: false, bold: false, underline: false, strike: false, smallCaps: false, mono: false, size: 24, link: false };
  for (const [i, { path, doc, cascade }] of docs.entries()) {
    if (ctx.cover && i < 2 && coverPage(doc)) continue;
    if (!first) pageBreak = true;
    first = false;
    const start = `${path}#`;
    if (bookmarks.has(start)) {
      pending = undefined;
      // The bookmark opens the chapter's first paragraph.
      startParagraph('\\pard\\plain\\sa120\\f0\\fs24');
      bookmark(start);
    }
    const body = elements(doc, 'body')[0]!;
    await children(body, path, cascade, inlineStyle(body, top, cascade), { left: 0, right: 0, pre: false, listDepth: 0, inCell: false, ...(pkg.direction === 'rtl' && { align: 'right' }) });
    endParagraph();
  }

  const header = [
    '{\\rtf1\\ansi\\ansicpg1252\\deff0\\uc1',
    // A Windows locale: the language's id with its default region (1033 English, 1036 French).
    `\\deflang${(languageCode(language(ctx)) || 9) | 0x400}`,
    '{\\fonttbl{\\f0\\froman\\fcharset0 Times New Roman;}{\\f1\\fmodern\\fcharset0 Courier New;}}',
    '{\\colortbl;\\red0\\green0\\blue238;}',
    `{\\stylesheet{\\s0\\snext0\\f0\\fs24 Normal;}${HEADING_SIZES.map((size, i) => `{\\s${i + 1}\\sbasedon0\\snext0\\outlinelevel${i}\\keepn\\b\\f0\\fs${size} heading ${i + 1};}`).join('')}}`,
    info(ctx),
    '\\paperw12240\\paperh15840\\margl1440\\margr1440\\margt1440\\margb1440\\widowctrl',
  ].join('\n');
  return new Blob([header, '\n', out.join(''), '}\n'], { type: 'application/rtf' });
}

const language = (ctx: ConvertContext) => (typeof ctx.item.metadata.language === 'string' ? ctx.item.metadata.language : undefined);

/** Plain text from a description's HTML. */
function plainText(html: string): string {
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
  for (const el of doc.querySelectorAll('br')) el.replaceWith('\n');
  for (const el of doc.querySelectorAll('p, div, li, h1, h2, h3, h4, h5, h6')) el.append('\n\n');
  return (doc.body.textContent ?? '').replace(/[ \t]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** The `\info` group: title, authors (`&` between them, as Calibre writes them), tags, description, publisher and dates. */
function info({ item }: ConvertContext): string {
  const text = (key: string) => (typeof item.metadata[key] === 'string' ? (item.metadata[key] as string) : undefined);
  const field = (name: string, value: string | undefined) => (value?.trim() ? `{\\${name} ${rtfText(value.trim())}}` : '');
  const authors = item.creators.filter((c) => c.role === 'aut' || !c.role).map((c) => c.name);
  const description = text('description');
  const published = /^(\d{4})(?:-(\d{2}))?(?:-(\d{2}))?/.exec(text('published') ?? '');
  const creatim = published ? `{\\creatim\\yr${Number(published[1])}\\mo${Number(published[2] ?? 1)}\\dy${Number(published[3] ?? 1)}}` : '';
  return `{\\info${[
    field('title', item.title),
    field('author', authors.join(' & ')),
    field('keywords', item.tags.join(', ')),
    field('doccomm', description && plainText(description)),
    field('company', text('publisher')),
    creatim,
  ].join('')}}`;
}
