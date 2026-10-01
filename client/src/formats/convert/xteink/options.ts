/** Optimizer options, apart from the optimizer so device settings and converters can use them without loading it. */

export interface ImageOptions {
  /** JPEG quality, 1–100. */
  quality: number;
  grayscale: boolean;
  /** Trim uniform margins; off by default, since sparse title pages can be zoomed a lot. */
  autoCrop: boolean;
}

export interface OptimizeOptions extends ImageOptions {
  /** Split oversized paragraphs and files, and remove fonts, for the firmware's memory limits. */
  splitText: boolean;
}

export const DEFAULT_IMAGE_OPTIONS: ImageOptions = { quality: 85, grayscale: true, autoCrop: false };
export const DEFAULT_OPTIMIZE_OPTIONS: OptimizeOptions = { ...DEFAULT_IMAGE_OPTIONS, splitText: true };

/** The optimizer's own version: bump it when its output changes. */
const OPTIMIZER_VERSION = '1';

/**
 * The converter version for these options. Options are inputs to the output, so a copy made with other options
 * reads as stale and is made again. The defaults give the plain version, which copies made before options existed have.
 */
export function optimizerVersion(options: OptimizeOptions): string {
  const d = DEFAULT_OPTIMIZE_OPTIONS;
  const parts = [
    options.quality !== d.quality && `q${options.quality}`,
    options.grayscale !== d.grayscale && (options.grayscale ? 'gray' : 'color'),
    options.autoCrop !== d.autoCrop && (options.autoCrop ? 'crop' : 'nocrop'),
    options.splitText !== d.splitText && (options.splitText ? 'split' : 'nosplit'),
  ].filter(Boolean);
  return [OPTIMIZER_VERSION, ...parts].join('+');
}
