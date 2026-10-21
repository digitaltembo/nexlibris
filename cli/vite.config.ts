import { defineConfig } from 'vitest/config';
import { assetUrls } from './nodeBuilds';

// Node, as the CLI runs: `src/environment.ts` gives the tools what they need of a browser, and the tools'
// browser-build imports load as the CLI's bundle loads them (pdf.js as its legacy build).
export default defineConfig({
  plugins: [assetUrls({ now: true })],
  resolve: {
    alias: [
      { find: /^pdfjs-dist\/build\//, replacement: 'pdfjs-dist/legacy/build/' },
      { find: /^pdfjs-dist$/, replacement: 'pdfjs-dist/legacy/build/pdf.mjs' },
    ],
  },
  test: { environment: 'node' },
});
