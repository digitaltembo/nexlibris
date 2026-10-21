import { Cascade, documentRules, fontScale, toEms } from '../../mobi/css';
import { fragmentOf, isExternal, resolveHref, type EpubPackage, type TocNode } from '../../mobi/epub';
import { elements, lonelySvgImage, removeComments, svgImageHref } from '../../mobi/markup';
import type { Family } from './fonts';
import { roman } from './options';

/**
 * A book's documents as a flow of blocks for typesetting: paragraphs of styled runs, images,
 * rules, tables, and the places chapters open, from the markup and what its CSS says (type,
 * sizes, alignment, indents, margins, page breaks, what's hidden). Lengths are in points.
 */

export interface RunStyle {
  family: Family;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  strike: boolean;
  smallCaps: boolean;
  vertical?: 'super' | 'sub';
  size: number;
}

export type Link = { uri: string } | { target: string };

export interface Run {
  /** Text with its spaces collapsed (outside `pre`); `\n` is a line break. */
  text: string;
  style: RunStyle;
  link?: Link;
  /** Places (`path#id`) starting where this run does. */
  anchors?: string[];
}

interface BlockBase {
  /** Space above and below, which collapse with the neighbours' as CSS margins do. */
  before: number;
  after: number;
  left: number;
  right: number;
  pageBreakBefore?: boolean;
  /** Places (`path#id`) at the block's top. */
  anchors: string[];
}

export interface Paragraph extends BlockBase {
  kind: 'text';
  runs: Run[];
  align: 'left' | 'center' | 'right' | 'justify';
  /** The first line's indent. */
  indent: number;
  pre: boolean;
  /** Kept on the page with the start of the block after it (headings). */
  keepWithNext: boolean;
  /** A list item's bullet or number, hung in its left margin. */
  marker?: Run;
  /** Its heading level, if a heading. */
  heading?: number;
}

export interface ImageBlock extends BlockBase {
  kind: 'image';
  data: Uint8Array;
  type: 'image/png' | 'image/jpeg';
  /** Pixels. */
  width: number;
  height: number;
  /** The width the CSS asks for, in points or as a share of the text's width. */
  cssWidth?: { points: number } | { share: number };
  align: 'left' | 'center' | 'right';
}

export interface RuleBlock extends BlockBase {
  kind: 'rule';
}

export interface TableBlock extends BlockBase {
  kind: 'table';
  rows: { cells: { blocks: Block[]; span: number; header: boolean }[] }[];
}

export interface ChapterStart {
  kind: 'chapter';
  /** The chapter's title as the table of contents gives it. */
  title: string;
  /** Its number, where chapters are numbered and this one counts. */
  number?: number;
  /** Whether it starts its own page. */
  newPage: boolean;
}

export interface PageBreak {
  kind: 'page';
}

export type Block = Paragraph | ImageBlock | RuleBlock | TableBlock | ChapterStart | PageBreak;

export interface Picture {
  data: Uint8Array;
  type: 'image/png' | 'image/jpeg';
  width: number;
  height: number;
}

interface Context {
  style: RunStyle;
  align: Paragraph['align'];
  left: number;
  right: number;
  pre: boolean;
  listDepth: number;
  inTable: boolean;
  link?: Link;
}

const DROPPED = new Set(['script', 'style', 'link', 'meta', 'title', 'head', 'template', 'rp', 'input', 'select', 'textarea', 'button', 'source', 'track', 'math', 'colgroup', 'col', 'caption']);
const BLOCKS = new Set(['p', 'div', 'section', 'article', 'aside', 'header', 'footer', 'nav', 'main', 'figure', 'figcaption', 'hgroup', 'details', 'summary', 'address', 'center', 'blockquote', 'pre', 'dl', 'dt', 'dd', 'ul', 'ol', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'body', 'table', 'hr']);
const ITALIC = new Set(['i', 'em', 'cite', 'var', 'dfn', 'address']);
const BOLD = new Set(['b', 'strong', 'th', 'dt', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6']);
const MONO = new Set(['code', 'tt', 'kbd', 'samp', 'pre']);
const HEADING_SCALES = [1.6, 1.35, 1.2, 1.05, 1, 1];
/** Characters with no width that would only show as missing glyphs. */
const INVISIBLE = /[­​-‏⁠﻿]/g;

const isBreak = (value: string | undefined) => value === 'always' || value === 'page' || value === 'left' || value === 'right';

/** Front and back matter, which chapter numbers leave out. */
const UNNUMBERED = /^(cover|title( ?page)?|half[ -]title|copyright|imprint|colophon|dedication|epigraph|(table of )?contents|toc|acknowledg(e)?ments?|about (the )?(author|authors|publisher|this book)|also by .*|other (books|works).*|(end)?notes|footnotes|bibliography|references|index|glossary|foreword|preface|introduction|prologue|epilogue|afterword|postscript|appendix\b.*|uncopyright|licen[cs]e|map|maps|dramatis personae|list of .*|cast of characters)$/i;
/** Titles already carrying a number, which keep theirs. */
const NUMBERED = /^((chapter|part|book|section|kapitel|chapitre|cap[ií]tulo|capitolo)\s+([0-9]+|[ivxlcdm]+|[a-z]+)\b|([0-9]+|[ivxlcdm]+)([.:)\-–—]|\s|$))/i;

export interface FlowOptions {
  /** The body's type size. */
  size: number;
  /** The text's width, for percentages. */
  width: number;
  chapterNumbers: boolean;
  /** The book's title, which a title page's entry in the contents has. */
  title: string;
  picture(path: string): Promise<Picture | undefined>;
}

export interface Flow {
  blocks: Block[];
  /** Chapters' titles and numbers by where they start (`path#` or `path#id`), for the bookmarks. */
  chapters: Map<string, { title: string; number?: number }>;
}

/** The book's spine as one flow of blocks. */
export async function bookFlow(pkg: EpubPackage, options: FlowOptions, skip: (doc: Document, index: number) => boolean): Promise<Flow> {
  const cssCache = new Map();
  // Printed pages, so `@media print` counts and Kindles' rules don't.
  const media = (query: string) => !/amzn-/i.test(query);

  // Chapters: the table of contents' top level, numbered from the body matter on.
  const chapters = new Map<string, { title: string; number?: number }>();
  const textStart = pkg.landmarks.find((l) => l.type === 'text' || l.type === 'bodymatter')?.path;
  const spineIndex = new Map(pkg.spine.map((item, i) => [item.path, i]));
  // Front matter: before the body matter's landmark, or before the contents page, or named for the book (a title page).
  const contentsAt = pkg.toc.find((n) => /^(table of )?contents$/i.test(n.label.trim()))?.path;
  const textIndex = Math.max(textStart ? (spineIndex.get(textStart) ?? 0) : 0, contentsAt ? (spineIndex.get(contentsAt) ?? -1) + 1 : 0);
  const simple = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  const title = simple(options.title);
  const namedForBook = (label: string) => Boolean(title) && (simple(label).includes(title) || title.includes(simple(label)));
  let number = 0;
  const top: TocNode[] = pkg.toc.length === 1 && pkg.toc[0]!.children.length > 1 && !pkg.toc[0]!.fragment ? pkg.toc[0]!.children : pkg.toc;
  for (const node of top) {
    const key = `${node.path}#${node.fragment ?? ''}`;
    if (chapters.has(key)) continue;
    const label = node.label.trim();
    const counts = options.chapterNumbers && (spineIndex.get(node.path) ?? 0) >= textIndex && !UNNUMBERED.test(label) && !namedForBook(label);
    if (counts) number++;
    chapters.set(key, { title: label, ...(counts && !NUMBERED.test(label) && { number }) });
  }

  const blocks: Block[] = [];
  for (const [index, item] of pkg.spine.entries()) {
    const doc = await pkg.document(item.path);
    const body = doc && elements(doc, 'body')[0];
    if (!doc || !body || skip(doc, index)) continue;
    removeComments(doc.documentElement);
    const cascade = new Cascade(doc, await documentRules(pkg, item.path, doc, cssCache, media));
    const writer = new FlowWriter(item.path, cascade, options, chapters, blocks);
    // Calibre's splits of one chapter run on; every other document starts a page.
    const continued = /_split_\d+\.x?html?$/i.test(item.path) && index > 0;
    const chapter = chapters.get(`${item.path}#`);
    if (chapter) blocks.push({ kind: 'chapter', ...chapter, newPage: true });
    else if (!continued && blocks.length) blocks.push({ kind: 'page' });
    writer.anchor(`${item.path}#`);
    await writer.body(body);
  }
  return { blocks, chapters };
}

class FlowWriter {
  #para?: Paragraph;
  /** What a new paragraph takes: the innermost block's properties. */
  #template: Omit<Paragraph, 'runs' | 'anchors'>;
  #anchors: string[] = [];
  #before = 0;
  #pageBreak = false;
  /** Whether the paragraph so far ends in a space, so collapsed spaces aren't doubled. */
  #spaced = true;

  constructor(
    readonly path: string,
    readonly cascade: Cascade,
    readonly options: FlowOptions,
    readonly chapters: Map<string, { title: string; number?: number }>,
    public blocks: Block[],
  ) {
    this.#template = { kind: 'text', align: 'left', indent: 0, pre: false, keepWithNext: false, before: 0, after: 0, left: 0, right: 0 };
  }

  anchor(place: string) {
    this.#anchors.push(place);
  }

  async body(body: Element) {
    const style: RunStyle = { family: 'serif', bold: false, italic: false, underline: false, strike: false, smallCaps: false, size: this.options.size };
    const context: Context = { style: this.#inline(body, style), align: 'left', left: 0, right: 0, pre: false, listDepth: 0, inTable: false };
    const align = this.#align(body);
    if (align) context.align = align;
    await this.#children(body, context);
    this.#flush();
  }

  #flush() {
    const para = this.#para;
    this.#para = undefined;
    this.#spaced = true;
    if (!para) return;
    // Spaces at a paragraph's end are only spacing.
    while (para.runs.length && !para.pre) {
      const last = para.runs.at(-1)!;
      last.text = last.text.replace(/ +$/, '');
      if (last.text || last.anchors?.length) break;
      para.runs.pop();
    }
    if (para.runs.length || para.marker) this.blocks.push(para);
  }

  #push(block: Exclude<Block, Paragraph>) {
    this.#flush();
    if ('anchors' in block) {
      block.anchors.push(...this.#anchors);
      this.#anchors = [];
      block.before = Math.max(block.before, this.#before);
      this.#before = 0;
      if (this.#pageBreak) block.pageBreakBefore = true;
      this.#pageBreak = false;
    }
    this.blocks.push(block);
  }

  #paragraph(): Paragraph {
    if (!this.#para) {
      this.#para = { ...this.#template, runs: [], anchors: this.#anchors, before: Math.max(this.#template.before, this.#before) };
      this.#anchors = [];
      this.#before = 0;
      if (this.#pageBreak) this.#para.pageBreakBefore = true;
      this.#pageBreak = false;
      // A block's first line is indented, not the text after a block within it.
      this.#template = { ...this.#template, indent: 0, before: 0, marker: undefined };
    }
    return this.#para;
  }

  #text(text: string, context: Context) {
    let value = text.replace(INVISIBLE, '');
    if (!context.pre) {
      value = value.replace(/[ \t\r\n\f]+/g, ' ');
      if (this.#spaced) value = value.replace(/^ /, '');
      if (!value) return;
      this.#spaced = value.endsWith(' ');
    } else {
      value = value.replace(/\r\n?/g, '\n');
      if (!value) return;
    }
    const para = this.#paragraph();
    const last = para.runs.at(-1);
    if (last && !last.anchors?.length && last.link === context.link && sameStyle(last.style, context.style)) last.text += value;
    else para.runs.push({ text: value, style: context.style, ...(context.link && { link: context.link }) });
  }

  #em(el: Element, property: string, size: number): number | undefined {
    const value = this.cascade.get(el, property);
    if (value?.endsWith('%')) return (parseFloat(value) / 100) * this.options.width;
    const ems = toEms(value);
    return ems === undefined ? undefined : ems * ((value ?? '').endsWith('rem') ? this.options.size : size);
  }

  #align(el: Element): Paragraph['align'] | undefined {
    const align = this.cascade.get(el, 'text-align');
    if (align === 'center' || align === 'right' || align === 'justify' || align === 'left') return align;
    if (align === 'start') return 'left';
    if (align === 'end') return 'right';
    return el.localName === 'center' ? 'center' : undefined;
  }

  #inline(el: Element, parent: RunStyle): RunStyle {
    const name = el.localName;
    const get = (p: string) => this.cascade.get(el, p);
    const style: RunStyle = { ...parent };
    const fontStyle = get('font-style');
    style.italic = fontStyle ? fontStyle === 'italic' || fontStyle === 'oblique' : ITALIC.has(name) || parent.italic;
    const weight = get('font-weight');
    style.bold = weight ? weight === 'bold' || weight === 'bolder' || parseInt(weight) >= 600 : BOLD.has(name) || parent.bold;
    const decoration = get('text-decoration');
    style.underline = (decoration ? decoration.includes('underline') : name === 'u' || name === 'ins') || parent.underline;
    style.strike = (decoration ? decoration.includes('line-through') : name === 's' || name === 'strike' || name === 'del') || parent.strike;
    const variant = get('font-variant');
    style.smallCaps = variant ? variant.includes('small-caps') : parent.smallCaps;
    const family = get('font-family');
    if (MONO.has(name) || /monospace|courier|consolas|menlo/.test(family ?? '')) style.family = 'mono';
    else if (family) style.family = 'serif';
    const vertical = get('vertical-align');
    if (name === 'sup' || vertical === 'super') style.vertical = 'super';
    else if (name === 'sub' || vertical === 'sub') style.vertical = 'sub';
    else if (vertical === 'baseline') delete style.vertical;
    const heading = /^h([1-6])$/.exec(name);
    const scale = fontScale(get('font-size'));
    if (scale !== undefined) style.size = Math.min(72, Math.max(5, ((get('font-size') ?? '').endsWith('rem') ? this.options.size : parent.size) * scale));
    else if (heading) style.size = this.options.size * HEADING_SCALES[Number(heading[1]) - 1]!;
    else if (name === 'small') style.size = parent.size * 0.85;
    else if (name === 'big') style.size = parent.size * 1.2;
    else if (name === 'pre' || (MONO.has(name) && parent.family !== 'mono')) style.size = parent.size * 0.88;
    return style;
  }

  async #children(el: Element, context: Context) {
    let number = Number(el.getAttribute('start')) || 1;
    for (const child of Array.from(el.childNodes)) {
      if (child.nodeType === 3) this.#text(child.nodeValue ?? '', context);
      else if (child.nodeType === 1) {
        const c = child as Element;
        let marker: string | undefined;
        if (c.localName === 'li') {
          const value = Number(c.getAttribute('value'));
          if (value) number = value;
          const type = this.cascade.get(c, 'list-style-type') ?? this.cascade.get(el, 'list-style-type') ?? this.cascade.get(el, 'list-style') ?? '';
          const ordered = el.localName === 'ol' && !/disc|circle|square/.test(type);
          marker = type.includes('none') ? '' : ordered ? `${/roman/.test(type) ? (/upper/.test(type) ? roman(number) : roman(number).toLowerCase()) : number}.` : '•';
          number++;
        }
        await this.#element(c, context, marker);
      }
    }
  }

  async #image(src: string | null | undefined, alt: string | null, el: Element, context: Context) {
    const pic = src && !isExternal(src) && !src.startsWith('data:') ? await this.options.picture(resolveHref(this.path, src)) : undefined;
    if (!pic) {
      if (alt?.trim()) this.#text(`[${alt.trim()}]`, { ...context, style: { ...context.style, italic: true } });
      return;
    }
    const width = this.cascade.get(el, 'width') ?? (el.getAttribute('width') ? `${el.getAttribute('width')}px` : undefined);
    let cssWidth: ImageBlock['cssWidth'];
    if (width?.endsWith('%')) cssWidth = { share: Math.min(1, parseFloat(width) / 100) };
    else if (width) {
      const ems = toEms(/^\d+(\.\d+)?$/.test(width) ? `${width}px` : width);
      if (ems) cssWidth = { points: ems * 12 };
    }
    const align = context.align === 'justify' ? 'center' : context.align === 'left' && !this.#para?.runs.length ? 'center' : context.align;
    this.#push({ kind: 'image', ...pic, ...(cssWidth && { cssWidth }), align, before: this.options.size * 0.4, after: this.options.size * 0.4, left: context.left, right: context.right, anchors: [] });
  }

  async #element(el: Element, parent: Context, marker?: string) {
    const name = el.localName;
    const cascade = this.cascade;
    if (DROPPED.has(name) || cascade.get(el, 'display') === 'none' || cascade.get(el, 'visibility') === 'hidden') return;
    const id = el.getAttribute('id') ?? (name === 'a' ? el.getAttribute('name') : null);
    const place = id ? `${this.path}#${id}` : undefined;
    const chapter = place && this.chapters.get(place);
    if (chapter) this.#push({ kind: 'chapter', ...chapter, newPage: false });
    const style = this.#inline(el, parent.style);
    const context: Context = { ...parent, style };

    if (name === 'br') {
      this.#paragraph().runs.push({ text: '\n', style });
      this.#spaced = true;
      return;
    }
    if (place) {
      // A place in running text is a run's; a block's, its first line's.
      if (this.#para && !BLOCKS.has(name)) this.#para.runs.push({ text: '', style, anchors: [place] });
      else this.anchor(place);
    }
    if (name === 'img') return this.#image(el.getAttribute('src'), el.getAttribute('alt'), el, context);
    if (name === 'svg') {
      const inner = lonelySvgImage(el);
      if (inner) await this.#image(svgImageHref(inner), el.querySelector('title')?.textContent ?? null, el, context);
      return;
    }
    if (name === 'hr') {
      this.#push({ kind: 'rule', before: parent.style.size * 0.7, after: parent.style.size * 0.7, left: parent.left, right: parent.right, anchors: [] });
      return;
    }
    if (name === 'rt') {
      this.#text(' (', context);
      await this.#children(el, context);
      this.#text(')', context);
      return;
    }
    if (name === 'table' && !parent.inTable) return this.#table(el, context);
    if (name === 'a') {
      const href = el.getAttribute('href');
      if (href && isExternal(href)) {
        if (/^(https?|mailto|ftp):/i.test(href)) context.link = { uri: href };
      } else if (href) {
        const target = href.startsWith('#') ? this.path : resolveHref(this.path, href);
        context.link = { target: `${target}#${fragmentOf(href) ?? ''}` };
      }
    }

    const display = cascade.get(el, 'display');
    const isBlock = display ? /^(block|list-item|table|flex|grid)$/.test(display) : BLOCKS.has(name);
    if (!isBlock || (parent.inTable && name === 'table')) {
      await this.#children(el, context);
      if (parent.inTable && (name === 'td' || name === 'th')) this.#text(' ', context);
      return;
    }

    // A block: its own paragraphs, and margins collapsing with its neighbours'.
    this.#flush();
    const size = style.size;
    const heading = /^h([1-6])$/.exec(name);
    const align = this.#align(el);
    if (align) context.align = align;
    if (name === 'blockquote') {
      context.left += size * 1.5;
      context.right += size * 1.5;
    }
    if (name === 'dd') context.left += size * 1.5;
    if (name === 'ul' || name === 'ol') context.listDepth++;
    if (name === 'li') context.left = parent.left + size * 1.5;
    context.left += Math.max(0, (this.#em(el, 'margin-left', size) ?? 0) + (this.#em(el, 'padding-left', size) ?? 0));
    context.right += Math.max(0, (this.#em(el, 'margin-right', size) ?? 0) + (this.#em(el, 'padding-right', size) ?? 0));
    context.left = Math.min(context.left, this.options.width * 0.4);
    context.right = Math.min(context.right, this.options.width * 0.3);
    if (name === 'pre' || (cascade.get(el, 'white-space') ?? '').startsWith('pre')) context.pre = true;
    const defaults = heading ? [size * 0.9, size * 0.5] : name === 'p' || name === 'dl' || name === 'blockquote' || name === 'pre' || ((name === 'ul' || name === 'ol') && !parent.listDepth) ? [size * 0.75, size * 0.75] : [0, 0];
    const before = Math.max(0, (this.#em(el, 'margin-top', size) ?? defaults[0]!) + (this.#em(el, 'padding-top', size) ?? 0));
    const after = Math.max(0, (this.#em(el, 'margin-bottom', size) ?? defaults[1]!) + (this.#em(el, 'padding-bottom', size) ?? 0));
    if (isBreak(cascade.get(el, 'page-break-before'))) this.#pageBreak = true;
    this.#before = Math.max(this.#before, before);
    const indent = this.#em(el, 'text-indent', size);

    const saved = this.#template;
    this.#template = {
      kind: 'text',
      align: context.align,
      indent: indent ?? (saved.indent && !heading ? saved.indent : 0),
      pre: context.pre,
      keepWithNext: Boolean(heading) || name === 'dt',
      before: 0,
      after: 0,
      left: context.left,
      right: context.right,
      ...(heading && { heading: Number(heading[1]) }),
      ...(marker !== undefined && marker !== '' && { marker: { text: marker, style: { ...style, bold: false, italic: false } } }),
    };
    const start = this.blocks.length;
    await this.#children(el, context);
    this.#flush();
    this.#template = saved;
    // Its bottom margin goes to its last block, else to what follows.
    const last = this.blocks.length > start ? this.blocks.at(-1) : undefined;
    if (last && 'after' in last) last.after = Math.max(last.after, after);
    else this.#before = Math.max(this.#before, after);
    if (isBreak(cascade.get(el, 'page-break-after'))) this.#pageBreak = true;
  }

  async #table(el: Element, context: Context) {
    const rows: TableBlock['rows'] = [];
    const saved = this.blocks;
    for (const tr of elements(el, 'tr').filter((r) => r.closest('table') === el)) {
      const cells: TableBlock['rows'][number]['cells'] = [];
      for (const cell of Array.from(tr.children).filter((c) => c.localName === 'td' || c.localName === 'th')) {
        this.blocks = [];
        const inner: Context = { ...context, left: 0, right: 0, listDepth: 0, inTable: true, align: this.#align(cell) ?? (cell.localName === 'th' ? 'center' : 'left'), style: this.#inline(cell, { ...context.style, size: context.style.size * 0.92 }) };
        const template = this.#template;
        this.#template = { kind: 'text', align: inner.align, indent: 0, pre: false, keepWithNext: false, before: 0, after: 0, left: 0, right: 0 };
        await this.#children(cell, inner);
        this.#flush();
        this.#template = template;
        cells.push({ blocks: this.blocks, span: Math.max(1, Number(cell.getAttribute('colspan')) || 1), header: cell.localName === 'th' });
      }
      if (cells.length) rows.push({ cells });
    }
    this.blocks = saved;
    if (rows.length) this.#push({ kind: 'table', rows, before: context.style.size * 0.75, after: context.style.size * 0.75, left: context.left, right: context.right, anchors: [] });
  }
}

const sameStyle = (a: RunStyle, b: RunStyle) =>
  a.family === b.family && a.bold === b.bold && a.italic === b.italic && a.underline === b.underline && a.strike === b.strike && a.smallCaps === b.smallCaps && a.vertical === b.vertical && a.size === b.size;
