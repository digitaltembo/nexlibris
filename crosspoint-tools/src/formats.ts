import type { FormatInfo } from '@nexlibris/tools/formats/formats';

declare module '@nexlibris/tools/formats/formats' {
  interface PluginFormats {
    'x4.epub': true;
    'x3.epub': true;
  }
}

/**
 * The CrossPoint readers' optimized EPUBs, made by the optimizer (`convert.ts`). They're EPUBs to
 * the rest of the tools, once registered (`registerFormats`): read, parsed, indexed and written as any EPUB is.
 */
export const CROSSPOINT_FORMATS = {
  'x4.epub': { label: 'EPUB (X4)', mediaType: 'application/epub+zip', epub: true },
  'x3.epub': { label: 'EPUB (X3)', mediaType: 'application/epub+zip', epub: true },
} satisfies Record<string, FormatInfo>;
