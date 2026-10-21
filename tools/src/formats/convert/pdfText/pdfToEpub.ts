import { buildEpub, escapeXml, type EpubChapter, type EpubResource } from '../../epubBuilder';
import { loadPdfjs } from '../../pdf';
import { bookFromItem, type ConvertContext } from '../bookFromItem';
import { classifyPage, computeStats, mergeSplitLines, repeatedEdges, type LayoutLine, type PageLayout, type Side } from './layout';
import { DEFAULT_PDF_TEXT_OPTIONS, type Margins, type PdfTextOptions } from './options';
import { BookVocabulary, endsParagraph, headingLabel, joinLines, pageBlocks, parseHeading, type Block } from './reflow';
import { textLayerLines, type Line, type TextItem, type TextStyles } from './textLayer';

/**
 * A PDF with a text layer (made from text, or scanned and OCR'd) as a reflowable EPUB, after
 * scan2epub: each page's text read from its layer, what's in the margins asked to be ignored left
 * out, lines classified against the book's own statistics so running heads and page numbers
 * drop out, lines joined into paragraphs (across pages too, with hyphens at line ends resolved),
 * and chapters from the PDF's bookmarks or its chapter openings. Contents pages are left out;
 * pages that are pictures are kept as images where there's a canvas to draw them. There's no OCR:
 * a PDF without a text layer is refused.
 */

export class NoTextLayerError extends Error {
  constructor() {
    super('This PDF has no text layer (it’s scanned images alone), so it needs OCR before it can be converted.');
  }
}

/** Fewer words a page than this, over the whole PDF, is no text layer. */
const MIN_WORDS_PER_PAGE = 5;
/** Pages with fewer body lines than this are drawn to see whether they're pictures. */
const PICTURE_MAX_LINES = 10;
const PICTURE_WIDTH = 1200;

type PdfDocument = Awaited<ReturnType<Awaited<ReturnType<typeof loadPdfjs>>['getDocument']>['promise']>;

const masked = (box: [number, number, number, number], m: Margins) => {
  const [cx, cy] = [(box[0] + box[2]) / 2, (box[1] + box[3]) / 2];
  return cx < m.left || cx > 1 - m.right || cy < m.top || cy > 1 - m.bottom;
};

/** A page drawn as a JPEG, with its share of dark pixels; undefined where there's no canvas. */
async function drawPage(doc: PdfDocument, n: number): Promise<{ jpeg: Uint8Array<ArrayBuffer>; ink: number } | undefined> {
  if (typeof document === 'undefined') return undefined;
  try {
    const page = await doc.getPage(n);
    const unscaled = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: PICTURE_WIDTH / unscaled.width });
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(viewport.width);
    canvas.height = Math.round(viewport.height);
    await page.render({ canvas, viewport }).promise;
    const pixels = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data;
    let dark = 0;
    for (let i = 0; i < pixels.length; i += 16) if (pixels[i]! * 0.3 + pixels[i + 1]! * 0.59 + pixels[i + 2]! * 0.11 < 128 && pixels[i + 3]! > 128) dark++;
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.85));
    if (!blob) return undefined;
    return { jpeg: new Uint8Array(await blob.arrayBuffer()), ink: dark / (pixels.length / 16) };
  } catch {
    return undefined;
  }
}

/** The pages its top-level bookmarks go to (0-based), with their titles, where it has two or more. */
async function bookmarkChapters(doc: PdfDocument): Promise<Map<number, string>> {
  const chapters = new Map<number, string>();
  const outline = await doc.getOutline().catch(() => null);
  for (const item of outline ?? []) {
    try {
      const dest = typeof item.dest === 'string' ? await doc.getDestination(item.dest) : item.dest;
      const ref = dest?.[0];
      if (!ref) continue;
      const index = typeof ref === 'number' ? ref : await doc.getPageIndex(ref);
      if (!chapters.has(index) && item.title.trim()) chapters.set(index, item.title.trim());
    } catch {
      // A bookmark to nowhere.
    }
  }
  return chapters.size >= 2 ? chapters : new Map();
}

interface Page {
  index: number;
  side: Side;
  lines: LayoutLine[];
  layout?: PageLayout;
  picture?: { jpeg: Uint8Array<ArrayBuffer>; ink: number };
}

/** The PDF as an EPUB, with the library's metadata and cover. */
export async function pdfToEpub(data: Blob, ctx: ConvertContext, options: PdfTextOptions = DEFAULT_PDF_TEXT_OPTIONS): Promise<Blob> {
  const pdfjs = await loadPdfjs();
  const task = pdfjs.getDocument({ data: new Uint8Array(await data.arrayBuffer()) });
  try {
    const doc = await task.promise;
    const other: Side = options.firstPage === 'right' ? 'left' : 'right';
    const pages: Page[] = [];
    let words = 0;
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      const content = await page.getTextContent();
      const side = (n - 1) % 2 === 0 ? options.firstPage : other;
      const lines: Line[] = textLayerLines(content.items as TextItem[], content.styles as TextStyles, page.view)
        .map((line) => ({ words: line.words.filter((w) => !masked(w.bbox, options.margins[side])) }))
        .filter((line) => line.words.length);
      words += lines.reduce((count, line) => count + line.words.filter((w) => /[\p{L}\p{N}]/u.test(w.text)).length, 0);
      pages.push({ index: n - 1, side, lines: mergeSplitLines(lines) });
      page.cleanup();
    }
    if (words < Math.max(10, doc.numPages * MIN_WORDS_PER_PAGE * 0.5)) throw new NoTextLayerError();

    const stats = computeStats(pages.map((p) => [p.side, p.lines]));
    const repeated = repeatedEdges(pages.map((p) => p.lines));
    for (const page of pages) {
      // Pages with little text may be pictures: they're drawn to see.
      const textLines = page.lines.filter((l) => /[\p{L}\p{N}]/u.test(l.text)).length;
      if (textLines < PICTURE_MAX_LINES) page.picture = await drawPage(doc, page.index + 1);
      page.layout = classifyPage(page.lines, stats[page.side], page.picture?.ink, repeated);
    }

    const vocabulary = new BookVocabulary(pages.flatMap((p) => p.lines.filter((l) => l.kind === 'body').map((l) => l.text)));
    const bookmarks = options.chapters === 'auto' ? await bookmarkChapters(doc) : new Map<number, string>();
    const byOpenings = options.chapters !== 'none' && !bookmarks.size;

    interface Chapter {
      title: string;
      blocks: (Block | { tag: 'img'; path: string })[];
    }
    const chapters: Chapter[] = [];
    const resources: EpubResource[] = [];
    let chapter: Chapter | undefined;
    const open = (title: string) => {
      chapter = { title, blocks: [] };
      chapters.push(chapter);
      return chapter;
    };
    for (const page of pages) {
      const layout = page.layout!;
      const flags = layout.flags;
      if (flags.includes('toc') || flags.includes('blank')) continue;
      let blocks = flags.includes('image') && page.picture ? [] : pageBlocks(layout, vocabulary);
      const bookmark = bookmarks.get(page.index);
      let leading = 0;
      while (leading < blocks.length && blocks[leading]!.tag === 'h2') leading++;
      if (bookmark !== undefined) {
        // The bookmark names the chapter, so its printed heading goes.
        open(bookmark);
        blocks = blocks.slice(leading);
      } else if (byOpenings && flags.includes('chapter_start')) {
        // The printed heading names the chapter.
        open(headingLabel(parseHeading(blocks.slice(0, leading).map((b) => b.text))));
        blocks = blocks.slice(leading);
      }
      const current = chapter ?? open('');
      if (flags.includes('image') && page.picture) {
        const path = `images/page-${page.index + 1}.jpg`;
        resources.push({ path, mediaType: 'image/jpeg', data: page.picture.jpeg });
        current.blocks.push({ tag: 'img', path });
        continue;
      }
      for (const block of blocks) {
        const previous = current.blocks.at(-1);
        // A paragraph running on from the page before.
        if (block === blocks[0] && block.continued && previous?.tag === 'p' && !previous.align && !endsParagraph(previous.lines.at(-1)!, block.lines[0], previous.stats)) {
          previous.text = joinLines([previous.text, block.text], vocabulary);
          previous.lines = [...previous.lines, ...block.lines];
          previous.stats = block.stats;
          continue;
        }
        current.blocks.push(block);
      }
    }
    // Bookmarks to pages left out (a contents page, a blank one) make no chapter.
    const kept = chapters.filter((c) => c.blocks.length);
    if (!kept.length) throw new NoTextLayerError();

    // A chapter with no title of its own takes its first heading, else its first words.
    for (const c of kept) {
      if (c.title) continue;
      const first = c.blocks.find((b): b is Block => b.tag === 'h2' || (b.tag === 'p' && Boolean((b as Block).text)));
      c.title = first ? (first.text.length > 60 ? `${first.text.slice(0, 57).trimEnd()}…` : first.text) : 'Untitled';
    }

    const html = (b: Chapter['blocks'][number]) => {
      if (b.tag === 'img') return `<p class="picture"><img src="../${b.path}" alt=""/></p>`;
      if (b.tag === 'hr') return '<hr/>';
      const style = b.align === 'center' ? ' style="text-align: center"' : b.align === 'right' ? ' style="text-align: right"' : '';
      return `<${b.tag}${style}>${escapeXml(b.text)}</${b.tag}>`;
    };
    const epubChapters: EpubChapter[] = kept.map((c, i) => ({
      id: `c${i + 1}`,
      title: c.title,
      body: `<h1>${escapeXml(c.title)}</h1>${c.blocks.map(html).join('')}`,
    }));
    return buildEpub({ ...bookFromItem(ctx), chapters: epubChapters, resources });
  } finally {
    void task.destroy();
  }
}

