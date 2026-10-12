/** Optimizer options, apart from the optimizer so the convert dialogs can offer them without loading it. */
import type { SettingField } from '../../../devices/types';

export interface ImageOptions {
  /** JPEG quality, 1–100. */
  quality: number;
  grayscale: boolean;
  /** Trim uniform margins; off by default, since sparse title pages can be zoomed a lot. */
  autoCrop: boolean;
}

export interface OptimizeOptions extends ImageOptions {
  /** Split oversized paragraphs, for the firmware's layout memory. */
  splitParagraphs: boolean;
  /**
   * Split long spine files into ~7 KB ones. Off by default: the firmware now streams and indexes long files
   * incrementally, and each piece shows as its own chapter.
   */
  splitChapters: boolean;
}

export const DEFAULT_IMAGE_OPTIONS: ImageOptions = { quality: 85, grayscale: true, autoCrop: false };
export const DEFAULT_OPTIMIZE_OPTIONS: OptimizeOptions = { ...DEFAULT_IMAGE_OPTIONS, splitParagraphs: true, splitChapters: false };

/** The options as asked for when converting, keyed as in `OptimizeOptions`. */
export const OPTIMIZE_FIELDS: SettingField[] = [
  {
    key: 'quality',
    label: 'Image quality',
    default: String(DEFAULT_OPTIMIZE_OPTIONS.quality),
    range: { min: 1, max: 100 },
    help: 'JPEG quality of images in the optimized copy. Lower is smaller and faster to open.',
  },
  {
    key: 'grayscale',
    label: 'Images',
    default: 'yes',
    choices: [
      { value: 'yes', label: 'Grayscale' },
      { value: 'no', label: 'Keep colour' },
    ],
    help: 'The screen is grayscale; colour images are larger for no gain on it.',
  },
  {
    key: 'autoCrop',
    label: 'Crop image margins',
    default: 'no',
    choices: [
      { value: 'no', label: 'No' },
      { value: 'yes', label: 'Yes' },
    ],
    help: 'Trims plain margins so illustrations fill the screen. Sparse pages can end up zoomed a lot.',
  },
  {
    key: 'splitParagraphs',
    label: 'Split long paragraphs',
    default: 'yes',
    choices: [
      { value: 'yes', label: 'Yes' },
      { value: 'no', label: 'No' },
    ],
    help: 'Splits very long paragraphs so the reader has the memory to lay them out.',
  },
  {
    key: 'splitChapters',
    label: 'Split long chapters',
    default: 'no',
    choices: [
      { value: 'no', label: 'No' },
      { value: 'yes', label: 'Yes' },
    ],
    help: 'Splits chapters into ~7 KB files, each shown as its own chapter. Only older firmware needs it.',
  },
];

/** Options from the convert dialog's values (`OPTIMIZE_FIELDS`), with the defaults for any missing or out of range. */
export function optimizeOptionsFrom(values: Record<string, string>): OptimizeOptions {
  const d = DEFAULT_OPTIMIZE_OPTIONS;
  const quality = Math.round(Number(values.quality));
  const flag = (key: string, fallback: boolean) => (values[key] === 'yes' ? true : values[key] === 'no' ? false : fallback);
  return {
    quality: quality >= 1 && quality <= 100 ? quality : d.quality,
    grayscale: flag('grayscale', d.grayscale),
    autoCrop: flag('autoCrop', d.autoCrop),
    splitParagraphs: flag('splitParagraphs', d.splitParagraphs),
    splitChapters: flag('splitChapters', d.splitChapters),
  };
}

/** The optimizer's own version: bump it when its output changes. */
const OPTIMIZER_VERSION = '2';

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
    options.splitParagraphs !== d.splitParagraphs && (options.splitParagraphs ? 'paras' : 'nosplit'),
    options.splitChapters !== d.splitChapters && (options.splitChapters ? 'chapters' : 'nochapters'),
  ].filter(Boolean);
  return [OPTIMIZER_VERSION, ...parts].join('+');
}
