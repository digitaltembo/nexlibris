/**
 * Sleep images for CrossPoint (crosspoint-reader's USER_GUIDE, "Sleep Screen"): uncompressed BMPs
 * at the screen's size, in `/.sleep` (one picked at random each time it sleeps), or a single
 * `/sleep.bmp`, which wins over the folder. Pictures are made into them here, in grayscale (the
 * screen is) so what's shown here is what the reader shows.
 */

export type Profile = 'X4' | 'X3';

/** Screen sizes, portrait, from the user guide. */
export const SCREEN: Record<Profile, { width: number; height: number }> = {
  X4: { width: 480, height: 800 },
  X3: { width: 528, height: 792 },
};

/** Where the reader looks, in order: the single image, then the folder, then its visible fallback. */
export const SLEEP_FILE = '/sleep.bmp';
export const SLEEP_FOLDER = '/.sleep';
export const SLEEP_FALLBACK_FOLDER = '/sleep';

/** The reader's `sleepScreen` setting: positions in its options (CrossPointSettings' SLEEP_SCREEN_MODE). */
export const SLEEP_CUSTOM = 2;
export const SLEEP_COVER_CUSTOM = 4;

/** Fill: crop to cover the screen. Fit: the whole picture, on white. */
export type Placement = 'fill' | 'fit';

/** RGBA pixels as a 24-bit uncompressed BMP (bottom-up rows, each padded to 4 bytes). */
export function encodeBmp(rgba: Uint8ClampedArray, width: number, height: number): Blob {
  const rowSize = Math.ceil((width * 3) / 4) * 4;
  const dataSize = rowSize * height;
  const buffer = new ArrayBuffer(54 + dataSize);
  const view = new DataView(buffer);
  // BITMAPFILEHEADER
  view.setUint8(0, 0x42);
  view.setUint8(1, 0x4d);
  view.setUint32(2, buffer.byteLength, true);
  view.setUint32(10, 54, true);
  // BITMAPINFOHEADER
  view.setUint32(14, 40, true);
  view.setInt32(18, width, true);
  view.setInt32(22, height, true);
  view.setUint16(26, 1, true);
  view.setUint16(28, 24, true);
  view.setUint32(34, dataSize, true);
  view.setInt32(38, 2835, true);
  view.setInt32(42, 2835, true);
  const bytes = new Uint8Array(buffer);
  for (let y = 0; y < height; y++) {
    const row = 54 + (height - 1 - y) * rowSize;
    for (let x = 0; x < width; x++) {
      const from = (y * width + x) * 4;
      const to = row + x * 3;
      bytes[to] = rgba[from + 2]!;
      bytes[to + 1] = rgba[from + 1]!;
      bytes[to + 2] = rgba[from]!;
    }
  }
  return new Blob([buffer], { type: 'image/bmp' });
}

/** Pixels in place as gray, by luminance; transparent ones as on white. */
export function toGray(rgba: Uint8ClampedArray) {
  for (let i = 0; i + 3 < rgba.length; i += 4) {
    const alpha = rgba[i + 3]! / 255;
    const gray = 0.2126 * rgba[i]! + 0.7152 * rgba[i + 1]! + 0.0722 * rgba[i + 2]!;
    rgba[i] = rgba[i + 1] = rgba[i + 2] = Math.round(gray * alpha + 255 * (1 - alpha));
    rgba[i + 3] = 255;
  }
}

/** Where a picture goes on the screen: its drawn rectangle. Exported for tests. */
export function placement(
  image: { width: number; height: number },
  screen: { width: number; height: number },
  how: Placement,
): { x: number; y: number; width: number; height: number } {
  const scale = (how === 'fill' ? Math.max : Math.min)(screen.width / image.width, screen.height / image.height);
  const width = Math.round(image.width * scale);
  const height = Math.round(image.height * scale);
  return { x: Math.round((screen.width - width) / 2), y: Math.round((screen.height - height) / 2), width, height };
}

/** A picture (any format the browser reads) as a sleep image for the reader's screen. */
export async function makeSleepImage(picture: Blob, profile: Profile, how: Placement): Promise<Blob> {
  const screen = SCREEN[profile];
  const bitmap = await createImageBitmap(picture).catch(() => {
    throw new Error('This isn’t a picture nexlibris can read.');
  });
  try {
    const canvas = document.createElement('canvas');
    canvas.width = screen.width;
    canvas.height = screen.height;
    const context = canvas.getContext('2d')!;
    context.fillStyle = '#fff';
    context.fillRect(0, 0, screen.width, screen.height);
    const at = placement(bitmap, screen, how);
    context.drawImage(bitmap, at.x, at.y, at.width, at.height);
    const pixels = context.getImageData(0, 0, screen.width, screen.height).data;
    toGray(pixels);
    return encodeBmp(pixels, screen.width, screen.height);
  } finally {
    bitmap.close();
  }
}

/** A name for a sleep image made from a file: its name as a .bmp, kept to what the reader's file names allow. */
export function sleepImageName(name: string, taken: ReadonlySet<string>): string {
  const stem = name.replace(/\.[^.]+$/, '').replace(/[^\w\- ]+/g, '').trim().slice(0, 60) || 'sleep';
  let candidate = `${stem}.bmp`;
  for (let n = 2; taken.has(candidate.toLowerCase()); n++) candidate = `${stem} ${n}.bmp`;
  return candidate;
}
