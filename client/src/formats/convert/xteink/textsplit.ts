/**
 * Text-side EPUB transformations for the low-RAM CrossPoint firmware, ported
 * from `crosspoint_reader/textsplit.py` in the CrossPoint Calibre plugins (MIT).
 *
 * The device lays out one <p> at a time, holding every word in RAM, and caches
 * whole spine files. On ~380 KB of RAM a multi-KB paragraph (~6 KB crashed an
 * X4; ~1.2 KB is comfortable) runs it out of memory, and spine files beyond
 * ~10 KB make indexing fragile. So this:
 *
 * - splits every <p> larger than PARA_LIMIT into ~PARA_TARGET-byte siblings, at
 *   sentence boundaries (inline tags kept whole),
 * - splits spine files whose <body> exceeds SPLIT_LIMIT into ~CHUNK_TARGET-byte
 *   files, adding them to the manifest and spine,
 * - points `href="…#fragment"` links at the chunk that now holds the anchor,
 * - moves base64 `data:` images into real files,
 * - removes embedded fonts and page-list navs.
 *
 * Each transformation checks that the visible text is unchanged and is skipped
 * if not, so this never corrupts a book. Sizes are in UTF-16 code units, close
 * enough to the Python's characters.
 */

export const SPLIT_LIMIT = 9500;
export const CHUNK_TARGET = 7000;
export const PARA_LIMIT = 1600;
export const PARA_TARGET = 1200;

const VOID = ['meta', 'link', 'img', 'br', 'hr', 'image', 'input', 'col', 'source'];
const FONT_RE = /\.(otf|ttf|woff2?)$/i;
const XHTML_RE = /\.(xhtml|html|htm)$/i;
/** Block-level content makes a <p> unsplittable. */
const BLOCK_RE = /<(?:p|div|table|ul|ol)\b/;
/** Inline wrappers that may be split into several same-tag siblings; some books wrap whole paragraphs in one. */
const INLINE_WRAP = ['span', 'em', 'i', 'b', 'strong', 'a', 'u', 'small', 'sub', 'sup'];
const ELEMENT_RE = /^(<(\w+)[^>]*>)([\s\S]*)(<\/\2>)$/;

/** Splits markup into its top-level balanced nodes: elements (with their contents) and text runs. */
export function parseNodes(s: string): string[] {
  const nodes: string[] = [];
  let i = 0;
  while (i < s.length) {
    if (s[i] !== '<') {
      const j = s.indexOf('<', i);
      const end = j === -1 ? s.length : j;
      nodes.push(s.slice(i, end));
      i = end;
      continue;
    }
    let depth = 0;
    let j = i;
    let k: number;
    for (;;) {
      k = s.indexOf('>', j);
      if (k === -1) throw new Error('unterminated tag');
      const tag = s.slice(j, k + 1);
      const name = /^<\/?(\w+)/.exec(tag)?.[1]?.toLowerCase() ?? '';
      if (tag.startsWith('<!--')) {
        k = s.indexOf('-->', j);
        if (k === -1) throw new Error('unterminated comment');
        k += 2;
      } else if (tag.startsWith('</')) {
        depth--;
      } else if (!(tag.endsWith('/>') || VOID.includes(name) || tag.startsWith('<!') || tag.startsWith('<?'))) {
        // Processing instructions and declarations never nest; everything else opens an element.
        depth++;
      }
      if (depth <= 0) break;
      j = s.indexOf('<', k);
      if (j === -1) throw new Error('unbalanced markup');
    }
    nodes.push(s.slice(i, k + 1));
    i = k + 1;
  }
  return nodes;
}

/**
 * Splits a text run into pieces of ~target at sentence (or else word) boundaries.
 * Lossless: boundary whitespace stays with the piece before it, so the pieces join back to `text`.
 */
export function splitTextSentences(text: string, target: number): string[] {
  const pieces: string[] = [];
  while (text.length > target) {
    // As Python's rfind(sub, 0, target): the match must end within the first `target` characters.
    let cut = text.lastIndexOf('. ', target - 2);
    if (cut !== -1) {
      cut += 2;
    } else {
      cut = text.lastIndexOf(' ', target - 1) + 1;
      if (cut === 0) break;
    }
    pieces.push(text.slice(0, cut));
    text = text.slice(cut);
  }
  pieces.push(text);
  return pieces;
}

/** Greedily packs pieces into groups of about `target`, dropping groups that are only whitespace. */
function pack(pieces: Iterable<string>, target: number): string[] {
  const groups: string[] = [];
  let current: string[] = [];
  let length = 0;
  const flush = () => {
    if (current.join('').trim()) groups.push(current.join(''));
    current = [];
    length = 0;
  };
  for (const piece of pieces) {
    if (length + piece.length > target && length > 0 && piece.trim()) flush();
    current.push(piece);
    length += piece.length;
  }
  flush();
  return groups;
}

/** Packs inline content into ~PARA_TARGET chunks, splitting long text and long inline wrappers. Lossless. */
function groupInline(inner: string): string[] {
  const pieces = parseNodes(inner).flatMap((token) => {
    if (token.length <= PARA_LIMIT) return [token];
    if (!token.startsWith('<')) return splitTextSentences(token, PARA_TARGET);
    const m = ELEMENT_RE.exec(token);
    if (m && INLINE_WRAP.includes(m[2]!.toLowerCase()) && !BLOCK_RE.test(m[3]!)) {
      return groupInline(m[3]!).map((g) => m[1]! + g + m[4]!);
    }
    return [token];
  });
  return pack(pieces, PARA_TARGET);
}

/** Rewrites each <p> bigger than PARA_LIMIT as several sibling <p>s. A <p> holding block-level tags is left alone. */
export function splitBigParagraphs(html: string): { html: string; changed: boolean } {
  const out: string[] = [];
  let changed = false;
  for (const node of parseNodes(html)) {
    const m = node.startsWith('<p') ? /^(<p\b[^>]*>)([\s\S]*)(<\/p>)$/.exec(node) : null;
    if (!m || m[2]!.length <= PARA_LIMIT || BLOCK_RE.test(m[2]!)) {
      // Look inside big containers (sections, divs) for paragraphs to split.
      if (node.startsWith('<') && !/^<(p|!|\/)/.test(node) && node.length > PARA_LIMIT) {
        const mm = ELEMENT_RE.exec(node);
        if (mm && !VOID.includes(mm[2]!)) {
          const inner = splitBigParagraphs(mm[3]!);
          if (inner.changed) {
            out.push(mm[1]! + inner.html + mm[4]!);
            changed = true;
            continue;
          }
        }
      }
      out.push(node);
      continue;
    }
    const [, open, inner, close] = m as unknown as [string, string, string, string];
    const groups = groupInline(inner);
    if (groups.length < 2) {
      out.push(node);
      continue;
    }
    // Only the first part keeps the paragraph's id, which links may point at.
    const continuation = open.replace(/\s+id="[^"]*"/, '');
    out.push(groups.map((g, k) => (k === 0 ? open : continuation) + g + close).join(''));
    changed = true;
  }
  return { html: out.join(''), changed };
}

/** Packs nodes into chunks of about `target`, recursing into containers too big for one. */
function chunkNodes(nodes: string[], target: number): string[] {
  const chunks: string[] = [];
  let current: string[] = [];
  let length = 0;
  const flush = () => {
    if (current.join('').trim()) chunks.push(current.join(''));
    current = [];
    length = 0;
  };
  for (const node of nodes) {
    if (node.length > SPLIT_LIMIT && node.startsWith('<')) {
      const m = /^<(\w+)[^>]*>/.exec(node)!;
      const open = m[0];
      const close = `</${m[1]}>`;
      flush();
      for (const sub of chunkNodes(parseNodes(node.slice(open.length, -close.length)), target)) {
        chunks.push(open + sub + close);
      }
    } else if (node.length > SPLIT_LIMIT) {
      flush();
      chunks.push(...splitTextSentences(node, target));
    } else {
      if (length + node.length > target && length > 0 && node.trim()) flush();
      current.push(node);
      length += node.length;
    }
  }
  flush();
  return chunks;
}

/** The body's extent in an (X)HTML document: its last `</body>`, as the Python's greedy match finds it. */
function bodyOf(doc: string) {
  const m = /(<body[^>]*>)([\s\S]*)(<\/body>)/.exec(doc);
  if (!m) return undefined;
  const start = m.index + m[1]!.length;
  return { start, end: start + m[2]!.length, body: m[2]! };
}

/** An oversized document as `[name, content]` chunks, the first keeping its name; [] if it needn't or can't split. */
export function splitXhtmlDoc(doc: string, basename: string): [string, string][] {
  const body = bodyOf(doc);
  if (!body || body.body.length <= SPLIT_LIMIT) return [];
  const chunks = chunkNodes(parseNodes(body.body), CHUNK_TARGET);
  if (chunks.length < 2) return [];
  const dot = basename.lastIndexOf('.');
  const [base, ext] = dot === -1 ? [basename, ''] : [basename.slice(0, dot), basename.slice(dot + 1)];
  const head = doc.slice(0, body.start);
  const tail = doc.slice(body.end);
  return chunks.map((chunk, k) => [k === 0 ? basename : `${base}_ek${k}.${ext}`, head + chunk + tail]);
}

/** The text a reader shows, with whitespace collapsed, for checking that a transformation kept it. */
export function visibleText(s: string): string {
  const body = /<body.*?>([\s\S]*)<\/body>/.exec(s)?.[1] ?? s;
  return body
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** An EPUB as entries in zip order, with text entries decoded, for the passes to rewrite. */
export interface EpubEntries {
  /** Zip paths in the order they're written; `mimetype` goes first regardless. */
  order: string[];
  data: Map<string, Uint8Array | string>;
  opfPath: string;
}

export interface TextSplitSummary {
  paragraphs: number;
  fileSplits: number;
  fonts: number;
  dataImages: number;
}

const decoder = new TextDecoder();
const text = (entries: EpubEntries, path: string) => {
  const value = entries.data.get(path)!;
  return typeof value === 'string' ? value : decoder.decode(value);
};
const attr = (tag: string, name: string) => new RegExp(`\\b${name}="([^"]*)"`).exec(tag)?.[1];
const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Runs the text passes over an EPUB's entries in place. `processImage` re-encodes images pulled out of `data:`
 * URIs (as JPEG); without it they're kept as they are. `log` hears about each step and anything skipped.
 */
export async function splitEpubText(
  entries: EpubEntries,
  processImage?: (data: Uint8Array, name: string) => Promise<Uint8Array>,
  log: (message: string) => void = () => undefined,
): Promise<TextSplitSummary> {
  const result: TextSplitSummary = { paragraphs: 0, fileSplits: 0, fonts: 0, dataImages: 0 };
  const { opfPath } = entries;
  let opf = text(entries, opfPath);
  const opfDir = dirname(opfPath);

  // Manifest by id: [href, the whole item tag].
  const items = new Map<string, [string, string]>();
  for (const [tag] of opf.matchAll(/<(?:\w+:)?item\b[^>]*\/?>/g)) {
    const id = attr(tag, 'id');
    const href = attr(tag, 'href');
    if (id && href) items.set(id, [href, tag]);
  }
  const spineIds = [...opf.matchAll(/<(?:\w+:)?itemref\b[^>]*\bidref="([^"]+)"/g)].map((m) => m[1]!);

  /** `<original basename>#<fragment>` to the basename of the chunk holding it now. */
  const anchors = new Map<string, string>();
  /** A chunk's zip path to the basename of the file it was split from. */
  const chunkOrigin = new Map<string, string>();

  for (const id of spineIds) {
    const entry = items.get(id);
    if (!entry) continue;
    const [href, itemTag] = entry;
    const path = resolveHref(opfDir, href);
    if (!entries.data.has(path) || !XHTML_RE.test(path)) continue;
    let doc = text(entries, path);

    if (doc.includes('data:image/')) {
      const extracted = await extractDataImages(entries, path, doc, opf, result, processImage, log);
      doc = extracted.doc;
      opf = extracted.opf;
      entries.data.set(path, doc);
    }

    const original = visibleText(doc);
    const body = bodyOf(doc);
    if (body) {
      let split = { html: body.body, changed: false };
      try {
        split = splitBigParagraphs(body.body);
      } catch (e) {
        log(`${basename(path)}: paragraph pass skipped (${errorMessage(e)})`);
      }
      if (split.changed) {
        const next = doc.slice(0, body.start) + split.html + doc.slice(body.end);
        if (visibleText(next) === original) {
          doc = next;
          entries.data.set(path, doc);
          result.paragraphs++;
        } else {
          log(`${basename(path)}: paragraph pass changed the text, reverted`);
        }
      }
    }

    let pieces: [string, string][] = [];
    try {
      pieces = splitXhtmlDoc(doc, basename(path));
    } catch (e) {
      log(`${basename(path)}: file split skipped (${errorMessage(e)})`);
    }
    if (!pieces.length) continue;
    const joined = pieces.map(([, content]) => visibleText(content)).join(' ');
    if (joined.replace(/\s+/g, ' ').trim() !== original) {
      log(`${basename(path)}: file split changed the text, reverted`);
      continue;
    }

    const zipDir = dirname(path);
    const hrefDir = dirname(href);
    const origin = basename(href);
    const insertAt = entries.order.indexOf(path);
    pieces.forEach(([name, content], k) => {
      const piecePath = join(zipDir, name);
      entries.data.set(piecePath, content);
      chunkOrigin.set(piecePath, origin);
      if (k > 0) entries.order.splice(insertAt + k, 0, piecePath);
      for (const [, fragment] of content.matchAll(/id="([^"]+)"/g)) anchors.set(`${origin}#${fragment}`, name);
    });
    const newItems = pieces.map(([name], k) =>
      k === 0 ? itemTag : `<item id="${id}_ek${k}" href="${join(hrefDir, name)}" media-type="application/xhtml+xml"/>`,
    );
    const newRefs = pieces.map((_, k) => `<itemref idref="${k === 0 ? id : `${id}_ek${k}`}"/>`);
    opf = opf.replace(itemTag, () => newItems.join('\n    '));
    opf = opf.replace(new RegExp(`<(?:\\w+:)?itemref\\b[^>]*\\bidref="${escapeRegExp(id)}"[^>]*\\/?>`), () =>
      newRefs.join('\n    '),
    );
    result.fileSplits++;
    log(`${basename(path)} → ${pieces.length} files (max ${Math.max(...pieces.map(([, c]) => c.length))} B)`);
  }

  // Point fragment links at the chunk holding the anchor, and drop page-list navs.
  for (const path of [...entries.order]) {
    if (!XHTML_RE.test(path) && !path.toLowerCase().endsWith('.ncx')) continue;
    const before = text(entries, path);
    let s = before;
    if (anchors.size) {
      s = s.replace(/((?:href|src)=")([^"#]+)#([^"]+)"/g, (_m, pre: string, file: string, fragment: string) => {
        const chunk = anchors.get(`${basename(file)}#${fragment}`);
        if (chunk && chunk !== basename(file)) file = join(dirname(file), chunk);
        return `${pre}${file}#${fragment}"`;
      });
      // A bare "#note1" is relative to its own file, which may have been split away from the anchor.
      const selfOrigin = chunkOrigin.get(path) ?? basename(path);
      s = s.replace(/(href=")#([^"]+)"/g, (m, pre: string, fragment: string) => {
        const chunk = anchors.get(`${selfOrigin}#${fragment}`);
        return chunk && chunk !== basename(path) ? `${pre}${chunk}#${fragment}"` : m;
      });
    }
    s = s.replace(/<nav[^>]*epub:type="page-list"[\s\S]*?<\/nav>/g, '');
    if (s !== before) entries.data.set(path, s);
  }

  // Embedded fonts: the firmware never uses them.
  for (const path of [...entries.order]) {
    if (FONT_RE.test(path)) {
      entries.order.splice(entries.order.indexOf(path), 1);
      entries.data.delete(path);
      result.fonts++;
    } else if (path.toLowerCase().endsWith('.css')) {
      const css = text(entries, path);
      const stripped = css.replace(/@font-face\s*\{[^}]*\}\s*/g, '');
      if (stripped !== css) entries.data.set(path, stripped);
    }
  }
  if (result.fonts) {
    opf = opf.replace(/\s*<(?:\w+:)?item\b[^>]*\.(?:otf|ttf|woff2?)[^>]*\/?>/gi, '');
    log(`removed ${result.fonts} embedded font(s)`);
  }

  entries.data.set(opfPath, opf);
  if (result.paragraphs) log(`split oversized paragraphs in ${result.paragraphs} file(s)`);
  return result;
}

const DATA_URI_RE = /(src|xlink:href)="data:image\/(png|jpe?g|gif|webp|bmp);base64,([^"]+)"/gi;

/** Moves base64 `data:` images in a spine file into zip entries with manifest items. */
async function extractDataImages(
  entries: EpubEntries,
  path: string,
  doc: string,
  opf: string,
  result: TextSplitSummary,
  processImage: ((data: Uint8Array, name: string) => Promise<Uint8Array>) | undefined,
  log: (message: string) => void,
): Promise<{ doc: string; opf: string }> {
  const opfDir = dirname(entries.opfPath);
  const replacements = new Map<string, string>();
  for (const m of doc.matchAll(DATA_URI_RE)) {
    const [whole, attribute, type, base64] = m as unknown as [string, string, string, string];
    if (replacements.has(whole)) continue;
    let raw: Uint8Array;
    try {
      raw = Uint8Array.from(atob(base64.replace(/\s+/g, '')), (c) => c.charCodeAt(0));
    } catch {
      continue;
    }
    const name = `dataimg_${result.dataImages++}`;
    let data = raw;
    let extension = type.toLowerCase() === 'jpeg' ? 'jpg' : type.toLowerCase();
    if (processImage) {
      try {
        data = await processImage(raw, name);
        extension = 'jpg';
      } catch (e) {
        log(`data-URI image kept as it was (${errorMessage(e)})`);
      }
    }
    const mediaType = extension === 'jpg' ? 'image/jpeg' : `image/${extension}`;
    const file = `${name}.${extension}`;
    const zipPath = join(dirname(path), file);
    entries.data.set(zipPath, data);
    entries.order.push(zipPath);
    const item = `<item id="${name}" href="${relative(zipPath, opfDir)}" media-type="${mediaType}"/>`;
    opf = opf.replace(/(<\/(?:\w+:)?manifest>)/, (close) => `${item}\n  ${close}`);
    log(`extracted ${(raw.length / 1024).toFixed(1)} KB data-URI image → ${file}`);
    replacements.set(whole, `${attribute}="${file}"`);
  }
  return { doc: doc.replace(DATA_URI_RE, (m) => replacements.get(m) ?? m), opf };
}

const errorMessage = (e: unknown) => (e instanceof Error ? e.message : String(e));

export const dirname = (path: string) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');
export const basename = (path: string) => path.slice(path.lastIndexOf('/') + 1);
export const join = (dir: string, name: string) => (dir ? `${dir}/${name}` : name);

/** Normalizes `.` and `..` segments. */
export function normalize(path: string): string {
  const parts: string[] = [];
  for (const part of path.split('/')) {
    if (part === '..') parts.pop();
    else if (part && part !== '.') parts.push(part);
  }
  return parts.join('/');
}

/** A manifest href as a zip path. Hrefs are URLs, so they may be percent-encoded. */
export function resolveHref(opfDir: string, href: string): string {
  let decoded = href.split('#')[0]!;
  try {
    decoded = decodeURIComponent(decoded);
  } catch {
    // Not valid percent-encoding; use it as it is.
  }
  return normalize(join(opfDir, decoded));
}

/** `path` relative to the directory `from`. */
function relative(path: string, from: string): string {
  const target = path.split('/');
  const base = from ? from.split('/') : [];
  let common = 0;
  while (common < base.length && common < target.length - 1 && base[common] === target[common]) common++;
  return [...base.slice(common).map(() => '..'), ...target.slice(common)].join('/');
}
