import JSZip from 'jszip';
import { EPUB_FORMATS, isEpub, READER_EPUBS, type FormatId } from '../formats/formats';
import { decodeText } from '../formats/text';
import { attribute, byLocalName, childElements, isElement, localName, nodeText, parseMarkup, rootElement, textContent, type Element } from './markup';

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

/** Bumped when extraction changes, so files are indexed again. 3: EPUBs read without the browser's DOM. */
export const EXTRACTOR_VERSION = 3;

/**
 * The most of a book's text that's indexed, in characters: a few times the longest novels. A
 * dictionary or encyclopedia has far more, and its index would take gigabytes to build.
 */
export const MAX_BOOK_TEXT = 16_000_000;
/** The biggest EPUB chapter read, in characters of its source: its DOM is built whole, with a path per text node. */
export const MAX_SECTION_SOURCE = 8_000_000;

/** The formats with text to extract, best first: which of an item's files is indexed. */
export const TEXT_FORMATS: FormatId[] = ['epub', 'pdf', 'txt', 'rtf', ...READER_EPUBS];

/**
 * Formats whose text is read anywhere, a worker included. PDFs and RTF need the page: pdf.js runs its own
 * worker from there, and rtf.js renders to the DOM (see `extractPage.ts`).
 */
export const WORKER_FORMATS: FormatId[] = [...EPUB_FORMATS, 'txt'];

export async function extractText(data: Blob, format: FormatId): Promise<TextDoc> {
  if (isEpub(format)) return extractEpub(data);
  switch (format) {
    case 'txt':
      return textDoc(collapse(decodeText(await data.arrayBuffer())));
    case 'pdf':
      return (await import('./extractPage')).extractPdf(data);
    case 'rtf':
      return (await import('./extractPage')).extractRtf(data);
    default:
      throw new Error(`There's no text to search in ${format} files.`);
  }
}

/** A text file's text as one section, cut at {@link MAX_BOOK_TEXT}. */
export const textDoc = (text: string): TextDoc => ({
  kind: 'text',
  sections: [{ ref: '', text: text.slice(0, MAX_BOOK_TEXT) }],
  ...(text.length > MAX_BOOK_TEXT && { truncated: true }),
});

/** Runs of spaces and tabs become one space, and blank lines one newline. */
export const collapse = (text: string) =>
  text
    .replace(/[^\S\n]+/g, ' ')
    .replace(/ ?\n[\s]*/g, '\n')
    .trim();

/** Lets the page breathe between chunks of work, where it's on the main thread. */
export const pause = () => new Promise((resolve) => setTimeout(resolve, 0));

/** A document read from the zip, if it's there. */
const parsed = (source: string | undefined) => (source === undefined ? undefined : parseMarkup(source));

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
  const container = parsed(await read('META-INF/container.xml'));
  const opfPath = container && byLocalName(container, 'rootfile').map((el) => attribute(el, 'full-path')).find(Boolean);
  const opf = opfPath ? parsed(await read(opfPath)) : undefined;
  const pkg = opf && rootElement(opf);
  if (!opfPath || !opf || !pkg) throw new Error('This EPUB has no readable package document.');

  const manifest = new Map(byLocalName(opf, 'item').map((el) => [attribute(el, 'id') ?? '', el]));
  const spine = byLocalName(opf, 'spine')[0];
  if (!spine) throw new Error('This EPUB has no spine.');
  const labels = await tocLabels(opfPath, manifest, read);
  // The spine's CFI step: its place among the package's children, then the itemref's among the spine's.
  const spineStep = (childElements(pkg).indexOf(spine) + 1) * 2;
  const itemrefs = childElements(spine).filter((el) => localName(el) === 'itemref');

  const sections: TextSection[] = [];
  let total = 0;
  let truncated = false;
  for (const [index, itemref] of itemrefs.entries()) {
    if (total >= MAX_BOOK_TEXT) {
      truncated = true;
      break;
    }
    const idref = attribute(itemref, 'idref') ?? '';
    const item = manifest.get(idref);
    const href = item && attribute(item, 'href');
    if (!href || !/x?html|xml/.test((item && attribute(item, 'media-type')) ?? '')) continue;
    const path = resolve(opfPath, href);
    const source = await read(path);
    if (!source) continue;
    if (source.length > MAX_SECTION_SOURCE) {
      truncated = true;
      continue;
    }
    const root = rootElement(parseMarkup(source));
    if (!root) continue;
    const { text, nodes, ids } = walk(root);
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
async function tocLabels(opfPath: string, manifest: Map<string, Element>, read: (path: string) => Promise<string | undefined>) {
  const labels = new Map<string, { fragment?: string; label: string }[]>();
  const add = (base: string, href: string | null | undefined, label: string | null | undefined) => {
    const name = label?.replace(/\s+/g, ' ').trim();
    if (!href || !name) return;
    const path = resolve(base, href);
    const fragment = href.includes('#') ? decodeURIComponent(href.slice(href.indexOf('#') + 1)) : undefined;
    labels.set(path, [...(labels.get(path) ?? []), { ...(fragment && { fragment }), label: name }]);
  };
  const items = [...manifest.values()];
  const nav = items.find((el) => attribute(el, 'properties')?.split(/\s+/).includes('nav'));
  const ncx = items.find((el) => attribute(el, 'media-type') === 'application/x-dtbncx+xml');
  const navHref = nav && attribute(nav, 'href');
  const ncxHref = ncx && attribute(ncx, 'href');
  /** EPUB's `epub:type`, whatever prefix the book gives the namespace. */
  const epubType = (el: Element) => Object.keys(el.attribs).find((name) => /(^|:)type$/.test(name) && name !== 'type');
  if (navHref) {
    const path = resolve(opfPath, navHref);
    const doc = parsed(await read(path));
    const navs = doc ? byLocalName(doc, 'nav') : [];
    const toc = navs.find((el) => /toc/.test(attribute(el, epubType(el) ?? '') ?? '')) ?? navs[0];
    for (const a of toc ? byLocalName(toc, 'a') : []) add(path, attribute(a, 'href'), textContent(a));
  } else if (ncxHref) {
    const path = resolve(opfPath, ncxHref);
    const doc = parsed(await read(path));
    for (const point of doc ? byLocalName(doc, 'navPoint') : []) {
      const text = byLocalName(point, 'text')[0];
      const content = byLocalName(point, 'content')[0];
      add(path, content && attribute(content, 'src'), text && textContent(text));
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
    for (const child of el.children) {
      if (isElement(child)) {
        elements++;
        const name = localName(child).toLowerCase();
        if (SKIPPED.has(name)) continue;
        const block = BLOCKS.has(name);
        if (block) newline();
        const id = attribute(child, 'id');
        if (id && !ids.has(id)) ids.set(id, length);
        visit(child, `${path}/${elements * 2}`);
        if (block) newline();
      } else if (child.type === 'text') {
        let value = nodeText(child.data).replace(/\s+/g, ' ');
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
