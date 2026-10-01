import { normalizeIsbn } from './isbn';

/**
 * Reading ISBN barcodes (EAN-13, starting 978 or 979) from camera frames or photos: with the
 * browser's `BarcodeDetector` where it has one that reads EAN-13 (Chrome on Android and macOS),
 * otherwise with zxing-cpp compiled to WebAssembly, loaded on first use from the app's own
 * files (never a CDN, so it works offline and in the apps).
 */

/** Something to read barcodes from: a playing video, or a decoded image. */
export type BarcodeSource = HTMLVideoElement | ImageBitmap;

export interface IsbnReader {
  /** Which decoder is in use, for the UI. */
  kind: 'native' | 'zxing';
  /** The ISBN-13s of the barcodes in view. */
  read(source: BarcodeSource): Promise<string[]>;
}

interface NativeDetector {
  detect(source: BarcodeSource): Promise<{ rawValue: string }[]>;
}
interface NativeDetectorClass {
  new (options: { formats: string[] }): NativeDetector;
  getSupportedFormats(): Promise<string[]>;
}

let reader: Promise<IsbnReader> | undefined;

/** The page's one reader; the decoder loads once. */
export const isbnReader = (): Promise<IsbnReader> => (reader ??= createReader());

async function createReader(): Promise<IsbnReader> {
  const Native = (globalThis as { BarcodeDetector?: NativeDetectorClass }).BarcodeDetector;
  if (Native) {
    try {
      if ((await Native.getSupportedFormats()).includes('ean_13')) {
        const detector = new Native({ formats: ['ean_13'] });
        return { kind: 'native', read: async (source) => isbns((await detector.detect(source)).map((b) => b.rawValue)) };
      }
    } catch {
      // Fall through to zxing.
    }
  }
  const [{ readBarcodes, setZXingModuleOverrides }, { default: wasmUrl }] = await Promise.all([
    import('zxing-wasm/reader'),
    import('zxing-wasm/reader/zxing_reader.wasm?url'),
  ]);
  setZXingModuleOverrides({ locateFile: (path: string, prefix: string) => (path.endsWith('.wasm') ? wasmUrl : prefix + path) });
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d', { willReadFrequently: true })!;
  return {
    kind: 'zxing',
    read: async (source) => {
      const width = source instanceof HTMLVideoElement ? source.videoWidth : source.width;
      const height = source instanceof HTMLVideoElement ? source.videoHeight : source.height;
      if (!width || !height) return [];
      // A barcode reads fine at this size, and big camera frames are slow to decode.
      const scale = Math.min(1, 1280 / Math.max(width, height));
      canvas.width = Math.round(width * scale);
      canvas.height = Math.round(height * scale);
      context.drawImage(source, 0, 0, canvas.width, canvas.height);
      const results = await readBarcodes(context.getImageData(0, 0, canvas.width, canvas.height), {
        formats: ['EAN13'],
        tryHarder: true,
        maxNumberOfSymbols: 1,
      });
      return isbns(results.filter((r) => r.isValid).map((r) => r.text));
    },
  };
}

/** The ISBN-13s among barcode values (other EAN-13s, like grocery barcodes, aren't ISBNs). */
export function isbns(values: string[]): string[] {
  return [...new Set(values.map((v) => normalizeIsbn(v)).filter((v): v is string => !!v))];
}

/** Reads a photo of a barcode. */
export async function readIsbnFromImage(file: Blob): Promise<string[]> {
  const image = await createImageBitmap(file);
  try {
    return await (await isbnReader()).read(image);
  } finally {
    image.close();
  }
}

/** Whether this browser can show the camera at all (it needs a secure context, and a camera to exist). */
export const cameraAvailable = () => typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia;
