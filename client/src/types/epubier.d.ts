declare module 'epubier' {
  export interface EpubierOptions {
    onBackPressed?: () => void;
    styles?: Record<string, string>;
    css?: string;
    theme?: string;
    font?: string;
    align?: 'justify' | 'left' | 'right' | 'original';
    textSize?: number;
    /** What saved data is keyed by; required when opening from an ArrayBuffer. */
    storageKey?: string;
    /** How epub.js points to images and other files inside the book: blob URLs (its default) or data URIs. */
    replacements?: 'blobUrl' | 'base64';
    /** A CFI to open at, instead of the position epubier saved itself. */
    position?: string;
    /** Called whenever the position changes; progress and pages are null until the pages are counted. */
    onLocationChange?: (location: EpubierLocation) => void;
  }

  export interface EpubierLocation {
    cfi: string;
    progress: number | null;
    page: number | null;
    totalPages: number | null;
  }

  export interface EpubierReader {
    element: HTMLElement;
    book: unknown;
    rendition: unknown;
    destroy(): void;
  }

  export default function epubier(element: HTMLElement, path: string | ArrayBuffer, opts?: EpubierOptions): EpubierReader;
}
