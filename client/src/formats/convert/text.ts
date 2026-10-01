import JSZip from 'jszip';
import { buildEpub, escapeXml, extensionFor, htmlToXhtml, type EpubChapter, type EpubResource } from '../epubBuilder';
import { decodeText, loadRtfjs } from '../text';
import { parseXml } from '../xml';
import { bookFromItem, type ConvertContext } from './bookFromItem';

const HEADING = /^(chapter|part|book|prologue|epilogue|introduction|preface|afterword|appendix)\b.{0,70}$|^[IVXLCDM]+\.?$|^\d{1,3}\.?$/i;
/** Texts with no headings are split into parts of about this many characters. */
const PART_SIZE = 40_000;

/** Splits plain text into paragraphs, unwrapping hard-wrapped lines when paragraphs are blank-line separated. */
export function textParagraphs(text: string): string[] {
  const normalized = text.replace(/\r\n?/g, '\n').trim();
  const blocks = normalized.split(/\n[ \t]*\n+/);
  const lines = normalized.split('\n').length;
  // Hard-wrapped paragraphs run a handful of lines; long blank-separated runs
  // are more likely one-paragraph-per-line text with the odd section break.
  if (blocks.length > 1 && lines / blocks.length <= 15) {
    return blocks.map((b) => b.replace(/\s*\n\s*/g, ' ').trim()).filter(Boolean);
  }
  return normalized.split('\n').map((l) => l.trim()).filter(Boolean);
}

/** Groups paragraphs into chapters at heading-like lines, or into fixed-size parts if there are none. */
export function textChapters(paragraphs: string[], fallbackTitle: string): { title: string; paragraphs: string[] }[] {
  const chapters: { title: string; paragraphs: string[] }[] = [];
  for (const p of paragraphs) {
    if (HEADING.test(p)) chapters.push({ title: p, paragraphs: [] });
    else if (chapters.length) chapters[chapters.length - 1]!.paragraphs.push(p);
    else chapters.push({ title: fallbackTitle, paragraphs: [p] });
  }
  if (chapters.length > 1) return chapters;

  const parts: { title: string; paragraphs: string[] }[] = [];
  let size = Infinity;
  for (const p of paragraphs) {
    if (size > PART_SIZE) {
      parts.push({ title: '', paragraphs: [] });
      size = 0;
    }
    parts[parts.length - 1]!.paragraphs.push(p);
    size += p.length;
  }
  return parts.map((part, i) => ({ ...part, title: parts.length === 1 ? fallbackTitle : `Part ${i + 1}` }));
}

export async function txtToEpub(data: Blob, ctx: ConvertContext): Promise<Blob> {
  const chapters = textChapters(textParagraphs(decodeText(await data.arrayBuffer())), ctx.item.title);
  return buildEpub({
    ...bookFromItem(ctx),
    chapters: chapters.map(
      (c, i): EpubChapter => ({
        id: `c${i + 1}`,
        title: c.title,
        body: `<h2>${escapeXml(c.title)}</h2>${c.paragraphs.map((p) => `<p>${escapeXml(p)}</p>`).join('')}`,
      }),
    ),
  });
}

/** Moves base64 `data:` images into EPUB resources, which readers handle far better. */
export function extractDataImages(html: string, prefix: string): { html: string; resources: EpubResource[] } {
  const resources: EpubResource[] = [];
  const rewritten = html.replace(/(src|href)="data:(image\/[a-z+]+);base64,([^"]+)"/g, (_m, attr: string, mediaType: string, b64: string) => {
    const path = `images/${prefix}${resources.length + 1}.${extensionFor(mediaType)}`;
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    resources.push({ path, mediaType, data: bytes });
    return `${attr}="../${path}"`;
  });
  return { html: rewritten, resources };
}

export async function rtfToEpub(data: Blob, ctx: ConvertContext): Promise<Blob> {
  const RTFJS = await loadRtfjs();
  const elements = await new RTFJS.Document(await data.arrayBuffer(), {}).render();
  const container = document.createElement('div');
  container.append(...elements);
  const { html, resources } = extractDataImages(container.innerHTML, 'rtf');
  return buildEpub({
    ...bookFromItem(ctx),
    chapters: [{ id: 'c1', title: ctx.item.title, body: htmlToXhtml(html) }],
    resources,
  });
}

const BLOCK = /^(p|div|h[1-6]|li|blockquote|pre|tr|section|article|header|footer|figure|figcaption|dt|dd)$/i;

function textOf(node: Node, out: string[]): void {
  for (const child of Array.from(node.childNodes)) {
    if (child.nodeType === Node.TEXT_NODE) out.push((child.textContent ?? '').replace(/\s+/g, ' '));
    else if (child.nodeType === Node.ELEMENT_NODE) {
      const el = child as Element;
      if (/^(script|style|head)$/i.test(el.localName)) continue;
      if (el.localName === 'br') out.push('\n');
      const block = BLOCK.test(el.localName);
      if (block) out.push('\n\n');
      textOf(el, out);
      if (block) out.push('\n\n');
    }
  }
}

/** Plain text from an EPUB's spine, in reading order. */
export async function epubToTxt(data: Blob, ctx: ConvertContext): Promise<Blob> {
  const zip = await JSZip.loadAsync(await data.arrayBuffer());
  const xml = async (path: string) =>
    parseXml((await zip.file(path)?.async('string')) ?? '') ?? new Document();
  const byLocalName = (doc: Document, name: string) =>
    Array.from(doc.getElementsByTagName('*')).filter((el) => el.localName === name);

  const container = await xml('META-INF/container.xml');
  const opfPath = byLocalName(container, 'rootfile')[0]?.getAttribute('full-path') ?? '';
  const opf = await xml(opfPath);
  const base = opfPath.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/') + 1) : '';
  const hrefs = new Map(byLocalName(opf, 'item').map((el) => [el.getAttribute('id'), el.getAttribute('href')]));

  const out: string[] = [ctx.item.title];
  if (ctx.item.creators.length) out.push(`\n${ctx.item.creators.map((c) => c.name).join(', ')}`);
  for (const ref of byLocalName(opf, 'itemref')) {
    const href = hrefs.get(ref.getAttribute('idref'));
    const file = href && zip.file(decodeURIComponent(base + href));
    if (!file) continue;
    const doc = new DOMParser().parseFromString(await file.async('string'), 'text/html');
    out.push('\n\n');
    textOf(doc.body, out);
  }
  const text = out
    .join('')
    .split('\n')
    .map((l) => l.trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return new Blob([text + '\n'], { type: 'text/plain;charset=utf-8' });
}
