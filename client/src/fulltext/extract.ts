import JSZip from 'jszip';
import type { FormatId } from '../formats/formats';
import { loadPdfjs } from '../formats/pdf';
import { decodeText, loadRtfjs } from '../formats/text';
import { parseXml } from '../formats/xml';

/**
 * A book's text for full-text search, in sections a reader can open at: an EPUB's spine items,
 * a PDF's pages, or a text file as one. Kept per file, in the instance's local state.
 */
export interface TextDoc {
  kind: 'epub' | 'pdf' | 'text';
  sections: TextSection[];
  /** Some of the text was left out: a section too big to read, or the book's past {@link MAX_BOOK_TEXT}. */
  truncated?: boolean;
}

export interface TextSection {
  /** For an EPUB, the CFI step of its spine item (`/6/8[id]`); for a PDF, the page number; else empty. */
  ref: string;
  /** The section's name, e.g. "Page 12". */
  label?: string;
  /** EPUB only: chapter names from the table of contents, from where each starts in `text` (a file can hold several). */
  labels?: [number, string][];
  /** Words with whitespace collapsed; blocks end in a newline. */
  text: string;
  /** EPUB only: where each text node starts in `text`, with its CFI path in the chapter (`/4/2/1`). */
  nodes?: [number, string][];
}

/** Bumped when extraction changes, so files are indexed again. */
export const EXTRACTOR_VERSION = 2;

/**
 * The most of a book's text that's indexed, in characters: a few times the longest novels. A
 * dictionary or encyclopedia has far more, and its index would take gigabytes to build.
 */
export const MAX_BOOK_TEXT = 16_000_000;
/** The biggest EPUB chapter read, in characters of its source: its DOM is built whole, with a path per text node. */
export const MAX_SECTION_SOURCE = 8_000_000;

/** The formats with text to extract, best first: which of an item's files is indexed. */
export const TEXT_FORMATS: FormatId[] = ['epub', 'pdf', 'txt', 'rtf', 'x4.epub', 'x3.epub'];

export async function extractText(data: Blob, format: FormatId): Promise<TextDoc> {
  switch (format) {
    case 'epub':
    case 'x4.epub':
    case 'x3.epub':
      return extractEpub(data);
    case 'pdf':
      return extractPdf(data);
    case 'txt':
      return textDoc(collapse(decodeText(await data.arrayBuffer())));
    case 'rtf':
      return extractRtf(data);
    default:
      throw new Error(`There's no text to search in ${format} files.`);
  }
}

/** A text file's text as one section, cut at {@link MAX_BOOK_TEXT}. */
const textDoc = (text: string): TextDoc => ({
  kind: 'text',
  sections: [{ ref: '', text: text.slice(0, MAX_BOOK_TEXT) }],
  ...(text.length > MAX_BOOK_TEXT && { truncated: true }),
});

/** Runs of spaces and tabs become one space, and blank lines one newline. */
const collapse = (text: string) =>
  text
    .replace(/[^\S\n]+/g, ' ')
    .replace(/ ?\n[\s]*/g, '\n')
    .trim();

/** Lets the page breathe between chunks of work on the main thread. */
const pause = () => new Promise((resolve) => setTimeout(resolve, 0));

const byLocalName = (root: Document | Element, name: string) =>
  Array.from(root.getElementsByTagName('*')).filter((el) => el.localName === name);

/** Paths in the zip are relative to the OPF's folder, and may be URL-encoded. */
function resolve(base: string, href: string): string {
  const parts = base.split('/').slice(0, -1);
  for (const part of decodeURIComponent(href.split('#')[0]!).split('/')) {
    if (part === '..') parts.pop();
    else if (part && part !== '.') parts.push(part);
  }
  return parts.join('/');
}

async function extractEpub(data: Blob): Promise<TextDoc> {
  const zip = await JSZip.loadAsync(await data.arrayBuffer());
  const read = async (path: string) => zip.file(path)?.async('string');
  const container = parseXml((await read('META-INF/container.xml')) ?? '');
  const opfPath = container && byLocalName(container, 'rootfile')[0]?.getAttribute('full-path');
  const opf = opfPath ? parseXml((await read(opfPath)) ?? '') : undefined;
  if (!opfPath || !opf) throw new Error('This EPUB has no readable package document.');

  const manifest = new Map(byLocalName(opf, 'item').map((el) => [el.getAttribute('id') ?? '', el]));
  const spine = byLocalName(opf, 'spine')[0];
  if (!spine) throw new Error('This EPUB has no spine.');
  const labels = await tocLabels(opf, opfPath, manifest, read);
  // The spine's CFI step: its place among the package's children, then the itemref's among the spine's.
  const spineStep = (Array.from(opf.documentElement.children).indexOf(spine) + 1) * 2;
  const itemrefs = Array.from(spine.children).filter((el) => el.localName === 'itemref');

  const sections: TextSection[] = [];
  let total = 0;
  let truncated = false;
  for (const [index, itemref] of itemrefs.entries()) {
    if (total >= MAX_BOOK_TEXT) {
      truncated = true;
      break;
    }
    const idref = itemref.getAttribute('idref') ?? '';
    const item = manifest.get(idref);
    const href = item?.getAttribute('href');
    if (!href || !/x?html|xml/.test(item?.getAttribute('media-type') ?? '')) continue;
    const path = resolve(opfPath, href);
    const source = await read(path);
    if (!source) continue;
    if (source.length > MAX_SECTION_SOURCE) {
      truncated = true;
      continue;
    }
    const doc = parseXml(source) ?? new DOMParser().parseFromString(source, 'text/html');
    const { text, nodes, ids } = walk(doc.documentElement);
    if (!text.trim()) continue;
    // Each entry of the table of contents pointing into this file names the text from its anchor on.
    const named = (labels.get(path) ?? [])
      .flatMap(({ fragment, label }): [number, string][] => {
        const at = fragment ? ids.get(fragment) : 0;
        return at === undefined ? [] : [[at, label]];
      })
      .sort((a, b) => a[0] - b[0]);
    sections.push({ ref: `/${spineStep}/${(index + 1) * 2}${idref ? `[${idref}]` : ''}`, ...(named.length && { labels: named }), text, nodes });
    total += text.length;
    await pause();
  }
  return { kind: 'epub', sections, ...(truncated && { truncated }) };
}

/** The table of contents' entries (EPUB 3's nav, else EPUB 2's NCX) by the file they point into, with the anchor. */
async function tocLabels(opf: Document, opfPath: string, manifest: Map<string, Element>, read: (path: string) => Promise<string | undefined>) {
  const labels = new Map<string, { fragment?: string; label: string }[]>();
  const add = (base: string, href: string | null | undefined, label: string | null | undefined) => {
    const name = label?.replace(/\s+/g, ' ').trim();
    if (!href || !name) return;
    const path = resolve(base, href);
    const fragment = href.includes('#') ? decodeURIComponent(href.slice(href.indexOf('#') + 1)) : undefined;
    labels.set(path, [...(labels.get(path) ?? []), { ...(fragment && { fragment }), label: name }]);
  };
  const items = [...manifest.values()];
  const nav = items.find((el) => el.getAttribute('properties')?.split(/\s+/).includes('nav'));
  const ncx = items.find((el) => el.getAttribute('media-type') === 'application/x-dtbncx+xml');
  if (nav?.getAttribute('href')) {
    const path = resolve(opfPath, nav.getAttribute('href')!);
    const doc = parseXml((await read(path)) ?? '');
    const toc = doc && (byLocalName(doc, 'nav').find((el) => /toc/.test(el.getAttribute('epub:type') ?? el.getAttributeNS('http://www.idpf.org/2007/ops', 'type') ?? '')) ?? byLocalName(doc, 'nav')[0]);
    for (const a of toc ? byLocalName(toc, 'a') : []) add(path, a.getAttribute('href'), a.textContent);
  } else if (ncx?.getAttribute('href')) {
    const path = resolve(opfPath, ncx.getAttribute('href')!);
    const doc = parseXml((await read(path)) ?? '');
    for (const point of doc ? byLocalName(doc, 'navPoint') : []) {
      const label = byLocalName(point, 'text')[0]?.textContent;
      add(path, byLocalName(point, 'content')[0]?.getAttribute('src'), label);
    }
  }
  return labels;
}

const SKIPPED = new Set(['head', 'script', 'style', 'svg', 'math', 'rt']);
const BLOCKS = new Set([
  'address', 'article', 'aside', 'blockquote', 'br', 'dd', 'div', 'dl', 'dt', 'figcaption', 'figure', 'footer',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hr', 'li', 'ol', 'p', 'pre', 'section', 'table', 'td', 'th', 'tr', 'ul',
]);

/**
 * A chapter's text, recording where each text node starts and its CFI path: elements are the
 * even steps (2, 4, …) among their siblings, and the text between them the odd ones.
 */
function walk(root: Element): { text: string; nodes: [number, string][]; ids: Map<string, number> } {
  // The text is kept in pieces, with its length and last character, and joined once: looking at
  // the end of a string built by appending makes V8 copy all of it, every time.
  const parts: string[] = [];
  let length = 0;
  let last = '';
  const append = (value: string) => {
    parts.push(value);
    length += value.length;
    last = value[value.length - 1]!;
  };
  const nodes: [number, string][] = [];
  /** Where each element with an id starts in the text, for the table of contents' anchors. */
  const ids = new Map<string, number>();
  const newline = () => {
    if (!length || last === '\n') return;
    if (last === ' ') {
      parts[parts.length - 1] = parts[parts.length - 1]!.slice(0, -1);
      length--;
    }
    append('\n');
  };
  const visit = (el: Element, path: string) => {
    let elements = 0;
    for (const child of Array.from(el.childNodes)) {
      if (child.nodeType === 1) {
        elements++;
        const name = (child as Element).localName.toLowerCase();
        if (SKIPPED.has(name)) continue;
        const block = BLOCKS.has(name);
        if (block) newline();
        const id = (child as Element).getAttribute('id');
        if (id && !ids.has(id)) ids.set(id, length);
        visit(child as Element, `${path}/${elements * 2}`);
        if (block) newline();
      } else if (child.nodeType === 3) {
        let value = (child.nodeValue ?? '').replace(/\s+/g, ' ');
        if (!length || last === '\n' || last === ' ') value = value.replace(/^ /, '');
        if (!value) continue;
        nodes.push([length, `${path}/${elements * 2 + 1}`]);
        append(value);
      }
    }
  };
  visit(root, '');
  return { text: parts.join('').trimEnd(), nodes, ids };
}

async function extractPdf(data: Blob): Promise<TextDoc> {
  const pdfjs = await loadPdfjs();
  const task = pdfjs.getDocument({ data: new Uint8Array(await data.arrayBuffer()) });
  try {
    const doc = await task.promise;
    const sections: TextSection[] = [];
    let total = 0;
    for (let page = 1; page <= doc.numPages; page++) {
      if (total >= MAX_BOOK_TEXT) return { kind: 'pdf', sections, truncated: true };
      const content = await (await doc.getPage(page)).getTextContent();
      let raw = '';
      for (const item of content.items) {
        if (!('str' in item)) continue;
        raw += item.str + (item.hasEOL ? '\n' : '');
      }
      const text = collapse(raw.replace(/-\n(?=\p{Ll})/gu, ''));
      if (text) sections.push({ ref: String(page), label: `Page ${page}`, text });
      total += text.length;
      if (page % 10 === 0) await pause();
    }
    return { kind: 'pdf', sections };
  } finally {
    void task.destroy();
  }
}

async function extractRtf(data: Blob): Promise<TextDoc> {
  const RTFJS = await loadRtfjs();
  const elements = await new RTFJS.Document(await data.arrayBuffer(), {}).render();
  return textDoc(collapse(elements.map((el) => el.textContent ?? '').join('\n')));
}
