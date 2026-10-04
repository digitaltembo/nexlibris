import { normalizeIsbn } from './isbn';

/**
 * Reading barcodes from camera frames or photos: ISBNs (EAN-13, starting 978 or 979), and QR codes
 * (M6 sync's pairing codes). With the browser's `BarcodeDetector` where it has one that reads the
 * format (Chrome on Android and macOS), otherwise with zxing-cpp compiled to WebAssembly, loaded
 * on first use from the app's own files (never a CDN, so it works offline and in the apps).
 */

/** Something to read barcodes from: a playing video, or a decoded image. */
export type BarcodeSource = HTMLVideoElement | ImageBitmap;

export interface BarcodeReader {
  /** Which decoder is in use, for the UI. */
  kind: 'native' | 'zxing';
  /** The values of the barcodes in view: ISBN-13s for an ISBN reader, the text of QR codes for a QR reader. */
  read(source: BarcodeSource): Promise<string[]>;
}

type BarcodeKind = 'isbn' | 'qr';

const FORMATS: Record<BarcodeKind, { native: string; zxing: 'EAN13' | 'QRCode'; values(raw: string[]): string[] }> = {
  isbn: { native: 'ean_13', zxing: 'EAN13', values: (raw) => isbns(raw) },
  qr: { native: 'qr_code', zxing: 'QRCode', values: (raw) => [...new Set(raw)] },
};

interface NativeDetector {
  detect(source: BarcodeSource): Promise<{ rawValue: string }[]>;
}
interface NativeDetectorClass {
  new (options: { formats: string[] }): NativeDetector;
  getSupportedFormats(): Promise<string[]>;
}

const readers: Partial<Record<BarcodeKind, Promise<BarcodeReader>>> = {};

/** The page's one reader of each kind; the decoder loads once. */
export const isbnReader = (): Promise<BarcodeReader> => (readers.isbn ??= createReader('isbn'));
export const qrReader = (): Promise<BarcodeReader> => (readers.qr ??= createReader('qr'));

async function createReader(kind: BarcodeKind): Promise<BarcodeReader> {
  const format = FORMATS[kind];
  const Native = (globalThis as { BarcodeDetector?: NativeDetectorClass }).BarcodeDetector;
  if (Native) {
    try {
      if ((await Native.getSupportedFormats()).includes(format.native)) {
        const detector = new Native({ formats: [format.native] });
        return { kind: 'native', read: async (source) => format.values((await detector.detect(source)).map((b) => b.rawValue)) };
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
        formats: [format.zxing],
        tryHarder: true,
        maxNumberOfSymbols: 1,
      });
      return format.values(results.filter((r) => r.isValid).map((r) => r.text));
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
