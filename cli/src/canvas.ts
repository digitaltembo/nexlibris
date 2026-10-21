import { createCanvas, ImageData, loadImage, type Canvas } from '@napi-rs/canvas';

/**
 * The browser's canvas under Node, from @napi-rs/canvas (Skia), as the tools draw on it: decoding
 * images (`createImageBitmap`), drawing and reading pixels (`OffscreenCanvas`, or a `<canvas>` from
 * `document.createElement`), and encoding them again (`convertToBlob`, `toBlob`, `toDataURL`). That
 * covers the CrossPoint optimizer's images and sleep images, cover colours, and PDFs' first pages.
 */

type Encodable = 'image/png' | 'image/jpeg' | 'image/webp';

/** A canvas's image as the browser would encode it: PNG unless JPEG or WebP is asked for, `quality` from 0 to 1. */
function encode(canvas: Canvas, type = 'image/png', quality?: number): Buffer {
  const mime: Encodable = type === 'image/jpeg' || type === 'image/webp' ? type : 'image/png';
  if (mime === 'image/png') return canvas.toBuffer('image/png');
  // Browsers' default quality is 0.92; Skia's is a percentage.
  return canvas.toBuffer(mime, Math.round((quality ?? 0.92) * 100));
}

/** A napi canvas with the `<canvas>` element's encoding methods. */
function canvasElement(width = 300, height = 150) {
  const canvas = createCanvas(width, height);
  return Object.assign(canvas, {
    toDataURL: (type?: string, quality?: number) => {
      const mime = type === 'image/jpeg' || type === 'image/webp' ? type : 'image/png';
      return `data:${mime};base64,${encode(canvas, type, quality).toString('base64')}`;
    },
    toBlob: (callback: (blob: Blob | null) => void, type?: string, quality?: number) => {
      const mime = type === 'image/jpeg' || type === 'image/webp' ? type : 'image/png';
      callback(new Blob([new Uint8Array(encode(canvas, type, quality))], { type: mime }));
    },
  });
}

class NodeOffscreenCanvas {
  readonly #canvas: Canvas;
  constructor(width: number, height: number) {
    this.#canvas = createCanvas(width, height);
  }
  get width() {
    return this.#canvas.width;
  }
  set width(width: number) {
    this.#canvas.width = width;
  }
  get height() {
    return this.#canvas.height;
  }
  set height(height: number) {
    this.#canvas.height = height;
  }
  getContext(kind: string) {
    return kind === '2d' ? this.#canvas.getContext('2d') : null;
  }
  async convertToBlob({ type = 'image/png', quality }: { type?: string; quality?: number } = {}) {
    const mime = type === 'image/jpeg' || type === 'image/webp' ? type : 'image/png';
    return new Blob([new Uint8Array(encode(this.#canvas, type, quality))], { type: mime });
  }
}

interface BitmapOptions {
  resizeWidth?: number;
  resizeHeight?: number;
}

/** An image decoded, as a canvas holding it (which `drawImage` takes as it takes a bitmap), resized if asked. */
async function createImageBitmap(source: Blob | ImageData, options: BitmapOptions = {}) {
  let width: number;
  let height: number;
  let draw: (canvas: Canvas) => void;
  if (source instanceof ImageData) {
    ({ width, height } = source);
    draw = (canvas) => {
      const full = createCanvas(source.width, source.height);
      full.getContext('2d').putImageData(source, 0, 0);
      canvas.getContext('2d').drawImage(full, 0, 0, canvas.width, canvas.height);
    };
  } else {
    // Throws, as the browser's rejects, for what it can't decode.
    const image = await loadImage(Buffer.from(await source.arrayBuffer()));
    ({ width, height } = image);
    draw = (canvas) => canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
  }
  const canvas = createCanvas(options.resizeWidth ?? width, options.resizeHeight ?? height);
  draw(canvas);
  return Object.assign(canvas, { close: () => undefined });
}

/** Gives Node the canvas, with `document` (happy-dom's) making `<canvas>` elements from it. */
export function installCanvas(document: { createElement(tag: string, options?: unknown): unknown }) {
  const createElement = document.createElement.bind(document);
  document.createElement = (tag: string, options?: unknown) => (tag.toLowerCase() === 'canvas' ? canvasElement() : createElement(tag, options));
  Object.assign(globalThis, { createImageBitmap, OffscreenCanvas: NodeOffscreenCanvas, ImageData });
}
