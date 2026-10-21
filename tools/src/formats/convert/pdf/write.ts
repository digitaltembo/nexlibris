import fontkit from '@pdf-lib/fontkit';
import { PDFDocument, PDFHexString, PDFName, PDFNull, PDFNumber, PDFString, rgb, type PDFImage, type PDFPage, type PDFRef } from 'pdf-lib';
import { readEpubPackage, type TocNode } from '../../mobi/epub';
import { elements } from '../../mobi/markup';
import { hasCanvas, imageType, redraw } from '../../mobi/resources';
import type { ConvertContext } from '../bookFromItem';
import { imageSize } from '../rtf';
import { bookFlow, type Block, type ImageBlock, type Link, type Paragraph, type Picture, type TableBlock } from './flow';
import { faceOf, Fonts, loadFontFiles, type FontFiles } from './fonts';
import { LINE_HEIGHT, setLines, type Line } from './lines';
import { DEFAULT_PDF_OPTIONS, PAGE_SIZES, roman, type PdfOptions } from './options';

/**
 * An EPUB typeset as a PDF, in the browser or under Node: the book's flow (`flow.ts`) set in
 * lines (`lines.ts`) on pages of the size chosen, each chapter from a new page, with the
 * library's cover first, running headers (the book's title, the chapter's, both, or neither),
 * page numbers, chapter numbers (Arabic or Roman) as the options say; links within the book and
 * to the web, bookmarks from the table of contents, and the library's metadata.
 */

const TEXT = rgb(0.08, 0.08, 0.08);
const QUIET = rgb(0.38, 0.38, 0.38);
const LINK = rgb(0.1, 0.27, 0.55);
const RULE = rgb(0.55, 0.55, 0.55);

interface PageInfo {
  page: PDFPage;
  /** The chapter in effect where the page begins, as its header shows it. */
  chapter?: string;
  opensChapter: boolean;
  cover: boolean;
}

interface Place {
  page: number;
  /** In PDF coordinates, from the page's foot. */
  y: number;
}

/** A picture as a PDF holds one, PNG or JPEG (others redrawn as PNG where there's a canvas). */
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
  return size && size.width > 0 && size.height > 0 ? { data, type: type as Picture['type'], ...size } : undefined;
}

/** Plain text from a description's HTML. */
function plainText(html: string): string {
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
  for (const el of doc.querySelectorAll('br')) el.replaceWith('\n');
  for (const el of doc.querySelectorAll('p, div, li')) el.append('\n\n');
  return (doc.body.textContent ?? '').replace(/[ \t]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** The book as a PDF. `fonts` are the typefaces' files, which are otherwise fetched. */
export async function epubToPdf(data: Blob, ctx: ConvertContext, options: PdfOptions = DEFAULT_PDF_OPTIONS, fontFiles?: FontFiles): Promise<Blob> {
  const pkg = await readEpubPackage(data);
  const pdf = await PDFDocument.create();
  pdf.registerFontkit(fontkit);
  const fonts = new Fonts(pdf, fontFiles ?? (await loadFontFiles()));
  await fonts.loadAll();

  const { width: pageWidth, height: pageHeight } = PAGE_SIZES[options.pageSize];
  const small = pageWidth < 500;
  const size = small ? 10.5 : 11.5;
  const margin = { left: pageWidth * 0.11, right: pageWidth * 0.11, top: pageHeight * 0.09, bottom: pageHeight * 0.085 };
  const textWidth = pageWidth - margin.left - margin.right;
  const textHeight = pageHeight - margin.top - margin.bottom;

  const pictures = new Map<string, Promise<Picture | undefined>>();
  const pictureAt = (path: string) => {
    if (!pictures.has(path)) {
      pictures.set(path, (async () => {
        const bytes = await pkg.read(path);
        return bytes && picture(bytes, pkg.byPath.get(path)?.mediaType ?? '');
      })());
    }
    return pictures.get(path)!;
  };
  // The book's own cover page gives way to the library's cover.
  const coverPage = (doc: Document, index: number) => {
    if (!ctx.cover || index > 1) return false;
    const body = elements(doc, 'body')[0]!;
    return !body.textContent?.trim() && elements(body).filter((e) => e.localName === 'img' || e.localName === 'image').length === 1;
  };
  const flow = await bookFlow(pkg, { size, width: textWidth, chapterNumbers: options.chapterNumbers, title: ctx.item.title, picture: pictureAt }, coverPage);
  const chapterName = (n: number) => (options.romanNumerals ? roman(n) : String(n));
  const chapterTitle = (c: { title: string; number?: number }) => (c.number !== undefined ? `${chapterName(c.number)}. ${c.title}` : c.title);

  const pages: PageInfo[] = [];
  const places = new Map<string, Place>();
  const links: { page: number; rect: [number, number, number, number]; link: Link }[] = [];
  const embedded = new Map<Uint8Array, Promise<PDFImage>>();
  const embed = (pic: { data: Uint8Array; type: string }) => {
    if (!embedded.has(pic.data)) embedded.set(pic.data, pic.type === 'image/png' ? pdf.embedPng(pic.data) : pdf.embedJpg(pic.data));
    return embedded.get(pic.data)!;
  };

  // The cover, filling the page.
  if (ctx.cover) {
    const pic = await picture(new Uint8Array(await ctx.cover.data.arrayBuffer()), ctx.cover.mediaType);
    if (pic) {
      const page = pdf.addPage([pageWidth, pageHeight]);
      const image = await embed(pic);
      const scale = Math.min(pageWidth / pic.width, pageHeight / pic.height);
      const w = pic.width * scale;
      const h = pic.height * scale;
      page.drawImage(image, { x: (pageWidth - w) / 2, y: (pageHeight - h) / 2, width: w, height: h });
      pages.push({ page, opensChapter: false, cover: true });
    }
  }

  let chapter: string | undefined;
  let page: PageInfo | undefined;
  /** How far down the text area the next block goes. */
  let y = 0;
  /** The space below the last block, which collapses with the next one's above. */
  let after = 0;
  const newPage = () => {
    page = { page: pdf.addPage([pageWidth, pageHeight]), ...(chapter && { chapter }), opensChapter: false, cover: false };
    pages.push(page);
    y = 0;
    after = 0;
  };
  const current = () => {
    if (!page) newPage();
    return page!;
  };
  const top = () => pageHeight - margin.top;
  const place = (anchors: string[], at: number) => {
    for (const anchor of anchors) if (!places.has(anchor)) places.set(anchor, { page: pages.length - 1, y: at });
  };

  const drawLine = (line: Line, x: number, lineTop: number, target: PDFPage) => {
    const baseline = lineTop - line.baseline;
    // Runs of one style drawn together, where the spaces between them are as the font has them.
    let run: { text: string; x: number; width: number; s: Line['segments'][number] } | undefined;
    const flush = () => {
      if (!run) return;
      const s = run.s;
      const font = fonts.font(s.style.family, faceOf(s.style.bold, s.style.italic));
      const color = s.link ? LINK : TEXT;
      target.drawText(run.text, { x: x + run.x, y: baseline + s.rise, size: s.size, font, color });
      if (s.style.underline) target.drawLine({ start: { x: x + run.x, y: baseline - s.size * 0.12 }, end: { x: x + run.x + run.width, y: baseline - s.size * 0.12 }, thickness: s.size * 0.05, color });
      if (s.style.strike) target.drawLine({ start: { x: x + run.x, y: baseline + s.size * 0.28 }, end: { x: x + run.x + run.width, y: baseline + s.size * 0.28 }, thickness: s.size * 0.05, color });
      run = undefined;
    };
    for (const s of line.segments) {
      if (s.link) {
        // One box for a link's words on a line.
        const last = links.at(-1);
        if (last && last.link === s.link && last.page === pages.length - 1 && last.rect[1] === baseline - s.size * 0.25) last.rect[2] = x + s.x + s.width;
        else links.push({ page: pages.length - 1, rect: [x + s.x, baseline - s.size * 0.25, x + s.x + s.width, baseline + s.size * 0.8], link: s.link });
      }
      const same = run && run.s.style === s.style && run.s.size === s.size && run.s.link === s.link;
      const gap = run ? s.x - (run.x + run.width) : 0;
      if (same && Math.abs(gap) < 0.01) {
        run!.text += s.text;
        run!.width += s.width;
        continue;
      }
      const space = same && !line.justified ? fonts.width(' ', s.style.family, faceOf(s.style.bold, s.style.italic), s.size) : -1;
      if (same && Math.abs(gap - space) < 0.01) {
        run!.text += ` ${s.text}`;
        run!.width += gap + s.width;
        continue;
      }
      flush();
      run = { text: s.text, x: s.x, width: s.width, s };
    }
    flush();
  };

  /** The height a block's first lines need, so a heading isn't left at a page's foot without them. */
  const firstLines = (block: Block | undefined): number => {
    if (!block) return 0;
    if (block.kind === 'text') return setLines(block, textWidth - block.left - block.right, fonts).slice(0, 2).reduce((n, l) => n + l.height, 0);
    if (block.kind === 'image') return Math.min(imageBox(block, textWidth).height, textHeight / 3);
    return size * LINE_HEIGHT;
  };

  const paragraph = (block: Paragraph, next: Block | undefined) => {
    const width = textWidth - block.left - block.right;
    const lines = setLines(block, width, fonts, block.heading ? 1.25 : undefined);
    if (block.pageBreakBefore && page && y > 0) newPage();
    let gap = y > 0 ? Math.max(after, block.before) : 0;
    if (block.keepWithNext && page && y > 0) {
      const need = lines.reduce((n, l) => n + l.height, 0) + firstLines(next);
      if (y + gap + need > textHeight && need < textHeight) {
        newPage();
        gap = 0;
      }
    }
    current();
    y += gap;
    let i = 0;
    while (i < lines.length) {
      let fit = 0;
      let h = 0;
      while (i + fit < lines.length && y + h + lines[i + fit]!.height <= textHeight + 0.01) h += lines[i + fit++]!.height;
      const left = lines.length - i;
      if (fit < left) {
        // No line left alone at a page's foot, nor at its head, where there are more to move.
        if (fit === 1 && i === 0 && lines.length > 1 && y > 0) fit = 0;
        else if (left - fit === 1 && fit >= 2) fit--;
      }
      if (fit === 0) {
        if (y === 0) fit = 1;
        else {
          newPage();
          continue;
        }
      }
      for (const line of lines.slice(i, i + fit)) {
        const lineTop = top() - y;
        place(line.anchors, lineTop);
        if (i === 0 && line === lines[0] && block.marker) {
          const m = block.marker;
          const face = faceOf(m.style.bold, m.style.italic);
          const mw = fonts.width(m.text, m.style.family, face, m.style.size);
          page!.page.drawText(m.text, { x: margin.left + block.left - mw - size * 0.45, y: lineTop - line.baseline, size: m.style.size, font: fonts.font(m.style.family, face), color: TEXT });
        }
        drawLine(line, margin.left + block.left, lineTop, page!.page);
        y += line.height;
      }
      i += fit;
      if (i < lines.length) newPage();
    }
    after = block.after;
  };

  const image = async (block: ImageBlock) => {
    let { width, height } = imageBox(block, textWidth - block.left - block.right);
    const scale = Math.min(1, (textHeight * 0.95) / height);
    width *= scale;
    height *= scale;
    if (block.pageBreakBefore && page && y > 0) newPage();
    let gap = y > 0 ? Math.max(after, block.before) : 0;
    if (page && y > 0 && y + gap + height > textHeight) {
      newPage();
      gap = 0;
    }
    current();
    y += gap;
    const avail = textWidth - block.left - block.right;
    const x = margin.left + block.left + (block.align === 'center' ? (avail - width) / 2 : block.align === 'right' ? avail - width : 0);
    place(block.anchors, top() - y);
    page!.page.drawImage(await embed(block), { x, y: top() - y - height, width, height });
    y += height;
    after = block.after;
  };

  /** A table's cells, set in their widths: each cell's lines and images, and each row's height. */
  const setTable = (block: TableBlock) => {
    const avail = textWidth - block.left - block.right;
    const columns = Math.max(...block.rows.map((r) => r.cells.reduce((n, c) => n + c.span, 0)));
    const pad = size * 0.35;
    return block.rows.map((row) => {
      let x = 0;
      const cells = row.cells.map((cell) => {
        const width = (avail * cell.span) / columns;
        const inner = width - pad * 2;
        const content: ({ line: Line; left: number } | { image: ImageBlock; width: number; height: number })[] = [];
        let height = 0;
        for (const b of cell.blocks) {
          if (b.kind === 'text') {
            for (const line of setLines(b, Math.max(10, inner - b.left - b.right), fonts)) {
              content.push({ line, left: b.left });
              height += line.height;
            }
          } else if (b.kind === 'image') {
            const s = imageBox(b, inner);
            content.push({ image: b, ...s });
            height += s.height;
          }
        }
        const placed = { x, width, content, height: height + pad * 2 };
        x += width;
        return placed;
      });
      return { cells, height: Math.max(size, ...cells.map((c) => c.height)) };
    });
  };

  const table = async (block: TableBlock) => {
    const rows = setTable(block);
    // A row taller than a page can't be drawn as one: its cells' text runs on as paragraphs instead.
    if (rows.some((r) => r.height > textHeight)) {
      for (const row of block.rows) for (const cell of row.cells) for (const b of cell.blocks) await blockAt(b, undefined);
      return;
    }
    let gap = y > 0 ? Math.max(after, block.before) : 0;
    current();
    place(block.anchors, top() - y - gap);
    const pad = size * 0.35;
    for (const row of rows) {
      if (y + gap + row.height > textHeight && y > 0) {
        newPage();
        gap = 0;
      }
      y += gap;
      gap = 0;
      const rowTop = top() - y;
      for (const cell of row.cells) {
        const left = margin.left + block.left + cell.x;
        page!.page.drawRectangle({ x: left, y: rowTop - row.height, width: cell.width, height: row.height, borderColor: RULE, borderWidth: 0.5 });
        let cy = rowTop - pad;
        for (const item of cell.content) {
          if ('line' in item) {
            place(item.line.anchors, cy);
            drawLine(item.line, left + pad + item.left, cy, page!.page);
            cy -= item.line.height;
          } else {
            page!.page.drawImage(await embed(item.image), { x: left + pad, y: cy - item.height, width: item.width, height: item.height });
            cy -= item.height;
          }
        }
      }
      y += row.height;
    }
    after = block.after;
  };

  const blockAt = async (block: Block, next: Block | undefined) => {
    switch (block.kind) {
      case 'text':
        paragraph(block, next);
        break;
      case 'image':
        await image(block);
        break;
      case 'table':
        await table(block);
        break;
      case 'rule': {
        const gap = y > 0 ? Math.max(after, block.before) : 0;
        if (page && y + gap + size > textHeight) newPage();
        else y += gap;
        current();
        const avail = textWidth - block.left - block.right;
        const ruleY = top() - y - size * 0.5;
        page!.page.drawLine({ start: { x: margin.left + block.left + avail * 0.375, y: ruleY }, end: { x: margin.left + block.left + avail * 0.625, y: ruleY }, thickness: 0.6, color: RULE });
        y += size;
        after = block.after;
        break;
      }
      case 'page':
        if (page && (y > 0 || pages.at(-1) !== page)) newPage();
        break;
      case 'chapter': {
        chapter = chapterTitle(block);
        if (block.newPage || !page) {
          if (!page || y > 0) newPage();
          page!.chapter = chapter;
          page!.opensChapter = true;
          // A chapter opens a little way down its page.
          y = textHeight * (block.number !== undefined && options.chapterNumbers ? 0.1 : 0.06);
        }
        if (block.number !== undefined && options.chapterNumbers) {
          current();
          const label = `Chapter ${chapterName(block.number)}`;
          const labelSize = size * 1.15;
          const font = fonts.font('serif', 'regular');
          const w = fonts.width(label, 'serif', 'regular', labelSize);
          if (y + labelSize * 3 > textHeight) newPage();
          page!.page.drawText(label, { x: margin.left + (textWidth - w) / 2, y: top() - y - labelSize, size: labelSize, font, color: QUIET });
          y += labelSize * 1.6;
          after = size * 0.6;
        }
        break;
      }
    }
  };

  for (const [i, block] of flow.blocks.entries()) await blockAt(block, flow.blocks[i + 1]);
  if (!pages.length) newPage();

  // Headers and page numbers.
  const headerSize = size * 0.82;
  const italic = fonts.font('serif', 'italic');
  const fit = (text: string, width: number) => {
    if (fonts.width(text, 'serif', 'italic', headerSize) <= width) return text;
    let cut = text;
    while (cut && fonts.width(`${cut}…`, 'serif', 'italic', headerSize) > width) cut = cut.slice(0, -1);
    return `${cut.trimEnd()}…`;
  };
  const book = ctx.item.title.trim();
  for (const [i, info] of pages.entries()) {
    if (info.cover) continue;
    const headerY = pageHeight - margin.top * 0.55;
    if (!info.opensChapter) {
      const left = options.bookHeader ? book : undefined;
      const right = options.chapterHeader ? info.chapter : undefined;
      const draw = (text: string, align: 'left' | 'center' | 'right', width: number) => {
        const t = fit(text, width);
        const w = fonts.width(t, 'serif', 'italic', headerSize);
        const x = align === 'left' ? margin.left : align === 'right' ? pageWidth - margin.right - w : (pageWidth - w) / 2;
        info.page.drawText(t, { x, y: headerY, size: headerSize, font: italic, color: QUIET });
      };
      if (left && right && left !== right) {
        draw(left, 'left', textWidth * 0.47);
        draw(right, 'right', textWidth * 0.47);
      } else if (left || right) draw((left ?? right)!, 'center', textWidth);
    }
    if (options.pageNumbers) {
      const n = String(i + 1);
      const w = fonts.width(n, 'serif', 'regular', headerSize);
      info.page.drawText(n, { x: (pageWidth - w) / 2, y: margin.bottom * 0.45, size: headerSize, font: fonts.font('serif', 'regular'), color: QUIET });
    }
  }

  // Links, within the book and out of it.
  const context = pdf.context;
  const pageRefs = pdf.getPages().map((p) => p.ref);
  const destination = (target: string) => {
    const at = places.get(target) ?? places.get(`${target.split('#')[0]}#`);
    return at && context.obj([pageRefs[at.page]!, PDFName.of('XYZ'), PDFNull, PDFNumber.of(Math.round(at.y + size)), PDFNull]);
  };
  for (const { page: index, rect, link } of links) {
    const action = 'uri' in link ? { A: context.obj({ Type: 'Action', S: 'URI', URI: PDFString.of(link.uri) }) } : (() => {
      const dest = destination(link.target);
      return dest && { Dest: dest };
    })();
    if (!action) continue;
    const annotation = context.register(context.obj({ Type: 'Annot', Subtype: 'Link', Rect: rect.map((n) => Math.round(n * 100) / 100), Border: [0, 0, 0], ...action }));
    pdf.getPage(index).node.addAnnot(annotation);
  }

  // Bookmarks from the table of contents, chapters as their headers name them.
  const outline = (nodes: TocNode[], parent: PDFRef, depth: number): { first?: PDFRef; last?: PDFRef; count: number } => {
    const items = nodes.flatMap((node) => {
      const dest = destination(`${node.path}#${node.fragment ?? ''}`);
      return dest ? [{ node, dest, ref: context.nextRef() }] : [];
    });
    let count = 0;
    items.forEach(({ node, dest, ref }, i) => {
      const known = flow.chapters.get(`${node.path}#${node.fragment ?? ''}`);
      const title = depth === 0 && known ? chapterTitle(known) : node.label.trim();
      const kids = outline(node.children, ref, depth + 1);
      const dict = context.obj({
        Title: PDFHexString.fromText(title),
        Parent: parent,
        Dest: dest,
        ...(i > 0 && { Prev: items[i - 1]!.ref }),
        ...(i < items.length - 1 && { Next: items[i + 1]!.ref }),
        ...(kids.first && { First: kids.first, Last: kids.last!, Count: -kids.count }),
      });
      context.assign(ref, dict);
      count += 1;
    });
    return { first: items[0]?.ref, last: items.at(-1)?.ref, count };
  };
  if (pkg.toc.length) {
    const root = context.nextRef();
    const { first, last, count } = outline(pkg.toc, root, 0);
    if (first) {
      context.assign(root, context.obj({ Type: 'Outlines', First: first, Last: last!, Count: count }));
      pdf.catalog.set(PDFName.of('Outlines'), root);
      pdf.catalog.set(PDFName.of('PageMode'), PDFName.of('UseOutlines'));
    }
  }

  // The library's metadata.
  const { item } = ctx;
  const text = (key: string) => (typeof item.metadata[key] === 'string' ? (item.metadata[key] as string) : undefined);
  pdf.setTitle(book || 'Untitled', { showInWindowTitleBar: true });
  const authors = item.creators.filter((c) => c.role === 'aut' || !c.role).map((c) => c.name);
  if (authors.length) pdf.setAuthor(authors.join(' & '));
  const description = text('description');
  if (description) pdf.setSubject(plainText(description));
  if (item.tags.length) pdf.setKeywords(item.tags);
  if (text('language')) pdf.setLanguage(text('language')!);
  pdf.setCreator('nexlibris');
  pdf.setProducer('nexlibris');
  if (pkg.direction === 'rtl') pdf.catalog.set(PDFName.of('ViewerPreferences'), context.obj({ Direction: 'R2L' }));
  return new Blob([(await pdf.save()) as Uint8Array<ArrayBuffer>], { type: 'application/pdf' });
}

/** An image's size on the page in points: as its CSS says, else at 96 pixels an inch, and no wider than `width`. */
function imageBox(block: ImageBlock, width: number): { width: number; height: number } {
  let w = block.cssWidth ? ('points' in block.cssWidth ? block.cssWidth.points : block.cssWidth.share * width) : block.width * 0.75;
  w = Math.min(w, width);
  return { width: w, height: (w * block.height) / block.width };
}
