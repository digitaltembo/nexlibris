/**
 * A cover's most prominent colour (`BookMetadata.coverColor`), for styling around the book. Pixels
 * are grouped into coarse colour bins; the bin chosen is the one with the most pixels, weighted
 * towards saturated colours, so a red title on a cream cover can win over the cream when there's
 * enough of it, while an all-grey cover still gives its grey. The colour is that bin's average.
 */

/** Small enough to be quick, big enough that the bins aren't decided by a few pixels. */
const SAMPLE_WIDTH = 48;
const SAMPLE_HEIGHT = 72;

/** The most prominent colour of RGBA pixels, as `#rrggbb`; undefined if none are opaque. */
export function dominantColor(pixels: Uint8ClampedArray): string | undefined {
  // 4 bits a channel: 4,096 bins of [count, r, g, b].
  const bins = new Float64Array(4096 * 4);
  for (let i = 0; i + 3 < pixels.length; i += 4) {
    if (pixels[i + 3]! < 128) continue;
    const [r, g, b] = [pixels[i]!, pixels[i + 1]!, pixels[i + 2]!];
    const bin = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
    bins[bin * 4]! += 1;
    bins[bin * 4 + 1]! += r;
    bins[bin * 4 + 2]! += g;
    bins[bin * 4 + 3]! += b;
  }
  let best = -1;
  let bestScore = 0;
  for (let bin = 0; bin < 4096; bin++) {
    const count = bins[bin * 4]!;
    if (!count) continue;
    const [r, g, b] = [bins[bin * 4 + 1]! / count, bins[bin * 4 + 2]! / count, bins[bin * 4 + 3]! / count];
    const saturation = (Math.max(r, g, b) - Math.min(r, g, b)) / 255;
    const score = count * (0.35 + saturation);
    if (score > bestScore) [best, bestScore] = [bin, score];
  }
  if (best < 0) return undefined;
  const count = bins[best * 4]!;
  const hex = (sum: number) => Math.round(sum / count).toString(16).padStart(2, '0');
  return `#${hex(bins[best * 4 + 1]!)}${hex(bins[best * 4 + 2]!)}${hex(bins[best * 4 + 3]!)}`;
}

/** A cover image's most prominent colour; undefined where it can't be decoded (or there's no canvas, as in tests). */
export async function coverColor(image: Blob): Promise<string | undefined> {
  if (typeof createImageBitmap !== 'function') return undefined;
  let bitmap: ImageBitmap | undefined;
  try {
    bitmap = await createImageBitmap(image, { resizeWidth: SAMPLE_WIDTH, resizeHeight: SAMPLE_HEIGHT, resizeQuality: 'low' });
    const canvas =
      typeof OffscreenCanvas === 'function'
        ? new OffscreenCanvas(SAMPLE_WIDTH, SAMPLE_HEIGHT)
        : Object.assign(document.createElement('canvas'), { width: SAMPLE_WIDTH, height: SAMPLE_HEIGHT });
    const context = canvas.getContext('2d') as OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D | null;
    if (!context) return undefined;
    context.drawImage(bitmap, 0, 0);
    return dominantColor(context.getImageData(0, 0, SAMPLE_WIDTH, SAMPLE_HEIGHT).data);
  } catch {
    return undefined;
  } finally {
    bitmap?.close();
  }
}
