import { ascii, concat, u32 } from './records';

/**
 * A Kindle book's images and fonts, each a record after the text: images as they are where a
 * Kindle shows them (JPEG, PNG, GIF), else redrawn as PNG; JPEGs redrawn where they lack the JFIF
 * header Kindles need or carry EXIF (which keeps a cover off the home screen), as Calibre does;
 * fonts zlib-compressed in FONT records (KF8 only). Redrawing needs a canvas, which browsers and
 * the CLI have; without one, images are kept as they are and others left out.
 */

export type ImageType = 'image/jpeg' | 'image/png' | 'image/gif';

const SIGNATURES: [number[], string][] = [
  [[0xff, 0xd8, 0xff], 'image/jpeg'],
  [[0x89, 0x50, 0x4e, 0x47], 'image/png'],
  [[0x47, 0x49, 0x46, 0x38], 'image/gif'],
  [[0x42, 0x4d], 'image/bmp'],
  [[0x52, 0x49, 0x46, 0x46], 'image/webp'],
];

/** An image's type by its first bytes, else its declared type. */
export function imageType(bytes: Uint8Array, declared = ''): string {
  return SIGNATURES.find(([magic]) => magic.every((b, i) => bytes[i] === b))?.[1] ?? declared;
}

/** A JPEG's APP segments: whether it has JFIF's (APP0) and EXIF's (APP1). */
function jpegSegments(bytes: Uint8Array) {
  let jfif = false;
  let exif = false;
  for (let at = 2; at + 4 <= bytes.length && bytes[at] === 0xff; ) {
    const marker = bytes[at + 1]!;
    if (marker === 0xda || marker === 0xd9) break;
    const length = (bytes[at + 2]! << 8) | bytes[at + 3]!;
    const name = String.fromCharCode(...bytes.subarray(at + 4, at + 8));
    if (marker === 0xe0 && name === 'JFIF') jfif = true;
    if (marker === 0xe1 && name === 'Exif') exif = true;
    at += 2 + length;
  }
  return { jfif, exif };
}

export const hasCanvas = () => typeof createImageBitmap === 'function' && (typeof OffscreenCanvas === 'function' || typeof document !== 'undefined');

/** An image drawn on a canvas `width` by `height` (on white, as Kindles have no transparency in JPEGs) and encoded. */
export async function redraw(bytes: Uint8Array, type: ImageType, quality: number, fit?: { width: number; height: number }) {
  const bitmap = await createImageBitmap(new Blob([bytes as Uint8Array<ArrayBuffer>]));
  try {
    const scale = fit ? Math.min(1, fit.width / bitmap.width, fit.height / bitmap.height) : 1;
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    if (typeof document === 'undefined') {
      const canvas = new OffscreenCanvas(width, height);
      const context = canvas.getContext('2d')!;
      if (type === 'image/jpeg') {
        context.fillStyle = '#fff';
        context.fillRect(0, 0, width, height);
      }
      context.drawImage(bitmap, 0, 0, width, height);
      return new Uint8Array(await (await canvas.convertToBlob({ type, quality })).arrayBuffer());
    }
    // On a page, the synchronous encoder: Chrome slows the asynchronous ones in background tabs.
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d')!;
    if (type === 'image/jpeg') {
      context.fillStyle = '#fff';
      context.fillRect(0, 0, width, height);
    }
    context.drawImage(bitmap, 0, 0, width, height);
    const url = canvas.toDataURL(type, quality);
    const binary = atob(url.slice(url.indexOf(',') + 1));
    return Uint8Array.from(binary, (c) => c.charCodeAt(0));
  } finally {
    bitmap.close();
  }
}

export interface KindleImage {
  data: Uint8Array;
  type: ImageType;
}

/** An image as a Kindle can show it, or undefined if it can't be made so. */
export async function kindleImage(bytes: Uint8Array, declared: string): Promise<KindleImage | undefined> {
  const type = imageType(bytes, declared);
  if (type === 'image/png' || type === 'image/gif') return { data: bytes, type };
  if (type === 'image/jpeg') {
    const { jfif, exif } = jpegSegments(bytes);
    if ((jfif && !exif) || !hasCanvas()) return { data: bytes, type };
    try {
      return { data: await redraw(bytes, 'image/jpeg', 0.9), type };
    } catch {
      return { data: bytes, type };
    }
  }
  if (!hasCanvas() || type === 'image/svg+xml') return undefined;
  try {
    return { data: await redraw(bytes, 'image/png', 1), type: 'image/png' };
  } catch {
    return undefined;
  }
}

/** The cover's thumbnail for a Kindle's home screen (180 by 240 at most, under 16 KB), or undefined without a canvas. */
export async function thumbnail(cover: Uint8Array): Promise<Uint8Array | undefined> {
  if (!hasCanvas()) return undefined;
  try {
    for (let quality = 0.9; quality > 0.2; quality -= 0.1) {
      const data = await redraw(cover, 'image/jpeg', quality, { width: 180, height: 240 });
      if (data.length <= 16 * 1024 || quality < 0.3) return data;
    }
  } catch {
    // Not an image the canvas can draw.
  }
  return undefined;
}

async function zlib(data: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
  const stream = new Blob([data as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new CompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** A font's FONT record: its size, flags (1: zlib), where its data starts, and no XOR key. */
export async function fontRecord(font: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
  return concat([ascii('FONT'), u32(font.length), u32(1), u32(24), u32(0), u32(24), await zlib(font)]);
}

/** A font as its publisher obfuscated it (IDPF's or Adobe's scheme, keyed by the book's identifier), restored. */
export async function deobfuscateFont(font: Uint8Array, algorithm: string, identifier: string): Promise<Uint8Array> {
  let key: Uint8Array;
  let length: number;
  if (algorithm === 'http://www.idpf.org/2008/embedding') {
    const digest = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(identifier.replace(/[ \t\r\n]/g, '')));
    key = new Uint8Array(digest);
    length = 1040;
  } else if (algorithm === 'http://ns.adobe.com/pdf/enc#RC') {
    const hex = identifier.replace(/^urn:uuid:/i, '').replace(/[^0-9a-f]/gi, '');
    if (hex.length !== 32) return font;
    key = Uint8Array.from({ length: 16 }, (_, i) => parseInt(hex.slice(2 * i, 2 * i + 2), 16));
    length = 1024;
  } else {
    return font;
  }
  const out = font.slice();
  for (let i = 0; i < Math.min(length, out.length); i++) out[i]! ^= key[i % key.length]!;
  return out;
}

/** A font's type by its first bytes, if it's one a FONT record holds. */
export function isFont(bytes: Uint8Array): boolean {
  const sig = String.fromCharCode(...bytes.subarray(0, 4));
  return sig === 'OTTO' || sig === 'true' || sig === 'ttcf' || (bytes[0] === 0 && bytes[1] === 1 && bytes[2] === 0 && bytes[3] === 0);
}

/** A transparent 1×1 GIF for an image a Kindle can't show, so its record numbers stay as they were. */
export const PLACEHOLDER_GIF = Uint8Array.from([
  0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 1, 0, 1, 0, 0x80, 0, 0, 0, 0, 0, 0xff, 0xff, 0xff, 0x21, 0xf9, 4, 1, 0, 0, 0, 0, 0x2c,
  0, 0, 0, 0, 1, 0, 1, 0, 0, 2, 2, 0x44, 1, 0, 0x3b,
]);
