/** Writing markup as UTF-8 while knowing where each byte lands, as Kindle indexes count in bytes. */

/** The length of a string once UTF-8 encoded (lone surrogates becoming U+FFFD, as TextEncoder writes them). */
export function utf8Length(text: string): number {
  let n = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c < 0xdc00 && i + 1 < text.length && (text.charCodeAt(i + 1) & 0xfc00) === 0xdc00) {
      n += 4;
      i++;
    } else n += 3;
  }
  return n;
}

export class ByteWriter {
  readonly #parts: string[] = [];
  length = 0;

  write(text: string) {
    this.#parts.push(text);
    this.length += utf8Length(text);
  }

  bytes(): Uint8Array<ArrayBuffer> {
    return new TextEncoder().encode(this.#parts.join(''));
  }
}

export const escapeText = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
export const escapeAttribute = (text: string) => escapeText(text).replace(/"/g, '&quot;');

/** HTML's elements that have no content or end tag. */
export const VOID_ELEMENTS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);

/** Removes comments and processing instructions, which Kindles don't keep. */
export function removeComments(root: Node) {
  for (const child of [...root.childNodes]) {
    if (child.nodeType === 8 || child.nodeType === 7) child.parentNode!.removeChild(child);
    else if (child.nodeType === 1) removeComments(child);
  }
}

/** Elements by local name, whatever their namespace. */
export const elements = (root: Document | Element, name?: string): Element[] =>
  Array.from(root.getElementsByTagName('*')).filter((el) => !name || el.localName === name);

/** The image an SVG wrapper shows, where it shows only that (as EPUB covers often are), else undefined. */
export function lonelySvgImage(svg: Element): Element | undefined {
  const ignored = new Set(['title', 'desc', 'metadata', 'g', 'defs']);
  const drawn = elements(svg).filter((el) => !ignored.has(el.localName) && !el.closest('defs'));
  return drawn.length === 1 && drawn[0]!.localName === 'image' ? drawn[0] : undefined;
}

/** An SVG `<image>`'s link, `href` or `xlink:href`. */
export const svgImageHref = (image: Element) =>
  image.getAttribute('href') ?? image.getAttributeNS('http://www.w3.org/1999/xlink', 'href') ?? image.getAttribute('xlink:href') ?? undefined;
