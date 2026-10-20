import { fromBase64 } from '@nexlibris/common';
import type { ImageOptions } from './options';

export { DEFAULT_IMAGE_OPTIONS, type ImageOptions } from './options';

/**
 * Image optimization for CrossPoint readers, ported from `process_image` in the
 * CrossPoint Calibre plugins' `optimizer.py` (MIT), itself a port of the
 * device web UI's canvas pipeline: optional auto-crop of uniform margins, scale
 * to fit the screen, flatten transparency onto white, grayscale, baseline JPEG.
 */

export interface Profile {
  label: string;
  /** Short and long edge, portrait. */
  width: number;
  height: number;
}

export const PROFILES = {
  X4: { label: 'X4', width: 480, height: 800 },
  X3: { label: 'X3', width: 528, height: 792 },
} satisfies Record<string, Profile>;

const CROP_WHITE_THRESHOLD = 245;
const CROP_BACKGROUND_TOLERANCE = 28;
const CROP_BACKGROUND_MAX_SPREAD = 24;
const CROP_EDGE_SAMPLE_SIZE = 12;
const CROP_PADDING_PX = 8;
const MIN_CROP_SAVINGS_RATIO = 0.08;
const MIN_COLOR_CROP_SAVINGS_RATIO = 0.2;
const MIN_CROP_DIMENSION = 240;
const COVER_NAME_RE = /(^|\/)(cover|thumbnail|thumb|icon)[^/]*\.(jpe?g|png|gif|webp|bmp)$/i;

/** RGBA pixels, as from `getImageData`. */
export interface Pixels {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

export interface Box {
  left: number;
  top: number;
  /** Exclusive. */
  right: number;
  bottom: number;
}

/** A pixel composited onto white. */
function flattened(data: Uint8ClampedArray, i: number): [number, number, number] {
  const a = data[i + 3]! / 255;
  return [0, 1, 2].map((c) => data[i + c]! * a + 255 * (1 - a)) as [number, number, number];
}

/** The mean colour of the edges, sampled in eight places, or undefined if they differ (no uniform margin). */
function estimateCropBackground({ width, height, data }: Pixels): [number, number, number] | undefined {
  const sample = Math.min(CROP_EDGE_SAMPLE_SIZE, Math.floor(width / 8), Math.floor(height / 8));
  if (sample < 2) return undefined;
  const midX = Math.floor((width - sample) / 2);
  const midY = Math.floor((height - sample) / 2);
  const corners: [number, number][] = [
    [0, 0], [width - sample, 0], [0, height - sample], [width - sample, height - sample],
    [midX, 0], [midX, height - sample], [0, midY], [width - sample, midY],
  ];
  const means = corners.map(([x0, y0]) => {
    const sum = [0, 0, 0];
    for (let y = y0; y < y0 + sample; y++) {
      for (let x = x0; x < x0 + sample; x++) {
        const px = flattened(data, (y * width + x) * 4);
        for (let c = 0; c < 3; c++) sum[c]! += px[c]!;
      }
    }
    return sum.map((s) => s / (sample * sample));
  });
  const average = [0, 1, 2].map((c) => means.reduce((s, m) => s + m[c]!, 0) / means.length) as [number, number, number];
  const spread = Math.max(...means.flatMap((m) => m.map((v, c) => Math.abs(v - average[c]!))));
  return spread > CROP_BACKGROUND_MAX_SPREAD ? undefined : average;
}

/** The box trimming an image's uniform margins, or undefined when cropping isn't worth it. */
export function findCropBox(pixels: Pixels): Box | undefined {
  const { width, height, data } = pixels;
  const background = estimateCropBackground(pixels);
  const [r0, g0, b0] = background?.map(Math.round) ?? [];
  // Inlined (no per-pixel arrays): this runs over every pixel of images that can be several megapixels.
  const isContent = (i: number) => {
    const a = data[i + 3]! / 255;
    const r = Math.round(data[i]! * a + 255 * (1 - a));
    const g = Math.round(data[i + 1]! * a + 255 * (1 - a));
    const b = Math.round(data[i + 2]! * a + 255 * (1 - a));
    if (r0 === undefined) return r < CROP_WHITE_THRESHOLD || g < CROP_WHITE_THRESHOLD || b < CROP_WHITE_THRESHOLD;
    const t = CROP_BACKGROUND_TOLERANCE;
    return Math.abs(r - r0) > t || Math.abs(g - g0!) > t || Math.abs(b - b0!) > t;
  };

  let left = width;
  let top = height;
  let right = 0;
  let bottom = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!isContent((y * width + x) * 4)) continue;
      left = Math.min(left, x);
      top = Math.min(top, y);
      right = Math.max(right, x + 1);
      bottom = Math.max(bottom, y + 1);
    }
  }
  if (right === 0) return undefined;

  const box = {
    left: Math.max(0, left - CROP_PADDING_PX),
    top: Math.max(0, top - CROP_PADDING_PX),
    right: Math.min(width, right + CROP_PADDING_PX),
    bottom: Math.min(height, bottom + CROP_PADDING_PX),
  };
  const saved = 1 - ((box.right - box.left) * (box.bottom - box.top)) / (width * height);
  const nearWhite = background?.every((c) => c >= CROP_WHITE_THRESHOLD);
  const minimum = !background || nearWhite ? MIN_CROP_SAVINGS_RATIO : MIN_COLOR_CROP_SAVINGS_RATIO;
  return saved < minimum ? undefined : box;
}

export function shouldSkipAutoCrop(path: string, width: number, height: number): boolean {
  return width < MIN_CROP_DIMENSION || height < MIN_CROP_DIMENSION || COVER_NAME_RE.test(path);
}

/**
 * The size to draw at: fitted to the screen, keeping the aspect ratio. An image that already fits is kept as it
 * is, unless it was cropped, which scales it up to fill the screen.
 */
export function fitSize(width: number, height: number, profile: Profile, cropped: boolean) {
  if (width <= profile.width && height <= profile.height && !cropped) return { width, height };
  const scale = Math.min(profile.width / width, profile.height / height);
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

/** Flattens onto white and, optionally, converts to grayscale with ITU-R 601 luma (as the device's web UI does). */
export function flattenPixels({ data }: Pixels, grayscale: boolean): void {
  for (let i = 0; i < data.length; i += 4) {
    const [r, g, b] = flattened(data, i);
    if (grayscale) {
      const luma = 0.299 * r + 0.587 * g + 0.114 * b;
      data[i] = data[i + 1] = data[i + 2] = luma;
    } else {
      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
    }
    data[i + 3] = 255;
  }
}

/** Optimizes one image with the browser's decoder and canvas. Throws if the image can't be decoded. */
export async function processImage(data: Uint8Array, path: string, profile: Profile, options: ImageOptions): Promise<Uint8Array> {
  const source = await createImageBitmap(new Blob([data as Uint8Array<ArrayBuffer>]));
  try {
    let crop: Box = { left: 0, top: 0, right: source.width, bottom: source.height };
    let cropped = false;
    if (options.autoCrop && !shouldSkipAutoCrop(path, source.width, source.height)) {
      const full = canvas(source.width, source.height);
      full.context.drawImage(source, 0, 0);
      const box = findCropBox(full.context.getImageData(0, 0, source.width, source.height));
      if (box) {
        crop = box;
        cropped = true;
      }
    }
    const size = fitSize(crop.right - crop.left, crop.bottom - crop.top, profile, cropped);
    const out = canvas(size.width, size.height);
    out.context.imageSmoothingQuality = 'high';
    out.context.drawImage(source, crop.left, crop.top, crop.right - crop.left, crop.bottom - crop.top, 0, 0, size.width, size.height);
    const pixels = out.context.getImageData(0, 0, size.width, size.height);
    flattenPixels(pixels, options.grayscale);
    out.context.putImageData(pixels, 0, 0);
    const jpeg = await out.toBlob('image/jpeg', options.quality / 100);
    return new Uint8Array(await jpeg.arrayBuffer());
  } finally {
    source.close();
  }
}

/**
 * A canvas to draw on and encode from. On a page it's a `<canvas>`, encoded with the synchronous `toDataURL`:
 * Chrome defers async encoding (`toBlob`, `convertToBlob`) in background tabs to about one a second, which made
 * a sync left running in another tab crawl. In a worker, where there's no DOM, it's an OffscreenCanvas.
 */
function canvas(width: number, height: number) {
  if (typeof document === 'undefined') {
    const c = new OffscreenCanvas(width, height);
    const context = c.getContext('2d', { willReadFrequently: true });
    if (!context) throw new Error('No 2D canvas');
    return { context, toBlob: (type: string, quality: number) => c.convertToBlob({ type, quality }) };
  }
  const c = document.createElement('canvas');
  c.width = width;
  c.height = height;
  const context = c.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('No 2D canvas');
  return {
    context,
    toBlob: async (type: string, quality: number) => {
      const url = c.toDataURL(type, quality);
      return new Blob([fromBase64(url.slice(url.indexOf(',') + 1))], { type });
    },
  };
}
