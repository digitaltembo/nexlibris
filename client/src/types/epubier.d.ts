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
  }

  export interface EpubierReader {
    element: HTMLElement;
    book: unknown;
    rendition: unknown;
    destroy(): void;
  }

  export default function epubier(element: HTMLElement, path: string | ArrayBuffer, opts?: EpubierOptions): EpubierReader;
}
