import type { PDFDocument, PDFFont } from 'pdf-lib';

/**
 * The PDF's typefaces: Literata, Google's typeface for ebooks (Latin, Greek and Cyrillic), for
 * the text, and JetBrains Mono for code, each in four faces, embedded as subsets of the glyphs
 * used. Text in scripts they lack (Chinese, Japanese, Arabic…) shows as missing glyphs.
 */

export type Family = 'serif' | 'mono';
export type Face = 'regular' | 'bold' | 'italic' | 'boldItalic';
export type FontFiles = Record<Family, Record<Face, Uint8Array>>;

const FACES: Face[] = ['regular', 'bold', 'italic', 'boldItalic'];
/** JetBrains Mono's programming ligatures (`->`, `//`), which code in a book shouldn't take, and whose glyphs fontkit misreads. */
const NO_LIGATURES = { calt: false, liga: false, dlig: false };

/** The fonts' files, bundled with the app (or found beside the CLI). */
export async function loadFontFiles(): Promise<FontFiles> {
  const urls = await Promise.all([
    import('@expo-google-fonts/literata/400Regular/Literata_400Regular.ttf?url'),
    import('@expo-google-fonts/literata/700Bold/Literata_700Bold.ttf?url'),
    import('@expo-google-fonts/literata/400Regular_Italic/Literata_400Regular_Italic.ttf?url'),
    import('@expo-google-fonts/literata/700Bold_Italic/Literata_700Bold_Italic.ttf?url'),
    import('@expo-google-fonts/jetbrains-mono/400Regular/JetBrainsMono_400Regular.ttf?url'),
    import('@expo-google-fonts/jetbrains-mono/700Bold/JetBrainsMono_700Bold.ttf?url'),
    import('@expo-google-fonts/jetbrains-mono/400Regular_Italic/JetBrainsMono_400Regular_Italic.ttf?url'),
    import('@expo-google-fonts/jetbrains-mono/700Bold_Italic/JetBrainsMono_700Bold_Italic.ttf?url'),
  ]);
  const files = await Promise.all(urls.map(async ({ default: url }) => new Uint8Array(await (await fetch(url)).arrayBuffer())));
  const family = (offset: number) => Object.fromEntries(FACES.map((face, i) => [face, files[offset + i]!])) as Record<Face, Uint8Array>;
  return { serif: family(0), mono: family(4) };
}

/** The faces embedded in a PDF as they're first used, with text widths remembered. */
export class Fonts {
  readonly #embedded = new Map<string, Promise<PDFFont>>();
  readonly #fonts = new Map<string, PDFFont>();
  readonly #widths = new Map<string, number>();

  constructor(
    readonly pdf: PDFDocument,
    readonly files: FontFiles,
  ) {}

  /** Embeds a face ahead of use: measuring and drawing are synchronous. */
  async load(family: Family, face: Face): Promise<PDFFont> {
    const key = `${family}-${face}`;
    if (!this.#embedded.has(key)) {
      this.#embedded.set(
        key,
        this.pdf.embedFont(this.files[family][face], { subset: true, ...(family === 'mono' && { features: NO_LIGATURES }) }).then((font) => {
          this.#fonts.set(key, font);
          return font;
        }),
      );
    }
    return this.#embedded.get(key)!;
  }

  async loadAll(): Promise<void> {
    await Promise.all((['serif', 'mono'] as Family[]).flatMap((family) => FACES.map((face) => this.load(family, face))));
  }

  font(family: Family, face: Face): PDFFont {
    const font = this.#fonts.get(`${family}-${face}`);
    if (!font) throw new Error(`The ${family} ${face} face isn't loaded.`);
    return font;
  }

  /** A text's width at a size. */
  width(text: string, family: Family, face: Face, size: number): number {
    const key = `${family}-${face}\u0000${text}`;
    let width = this.#widths.get(key);
    if (width === undefined) {
      width = this.font(family, face).widthOfTextAtSize(text, 1000);
      this.#widths.set(key, width);
    }
    return (width * size) / 1000;
  }
}

export const faceOf = (bold: boolean, italic: boolean): Face => (bold ? (italic ? 'boldItalic' : 'bold') : italic ? 'italic' : 'regular');
