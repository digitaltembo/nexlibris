import react from '@vitejs/plugin-react';
import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Plugin } from 'vite';
import { defineConfig } from 'vitest/config';

/**
 * pdf.js's character maps, standard fonts and image decoders, which it fetches for some PDFs, served at `pdfjs/`
 * (epubier's `pdf.assetsUrl`) rather than from a CDN, so PDFs read the same offline.
 */
function pdfjsAssets(): Plugin {
  const root = fileURLToPath(new URL('.', import.meta.resolve('pdfjs-dist/package.json')));
  const files = ['cmaps', 'standard_fonts', 'wasm'].flatMap((folder) => readdirSync(join(root, folder)).map((name) => `${folder}/${name}`));
  return {
    name: 'nexlibris-pdfjs-assets',
    configureServer(server) {
      server.middlewares.use('/pdfjs/', (req, res, next) => {
        const file = decodeURIComponent(req.url?.split('?')[0] ?? '').replace(/^\//, '');
        if (!files.includes(file)) return next();
        if (file.endsWith('.wasm')) res.setHeader('Content-Type', 'application/wasm');
        res.end(readFileSync(join(root, file)));
      });
    },
    generateBundle() {
      for (const file of files) this.emitFile({ type: 'asset', fileName: `pdfjs/${file}`, source: readFileSync(join(root, file)) });
    },
  };
}

/**
 * epubier's worker for CBR and CB7 comics and the libarchive it loads from beside itself, served at `epubier/`
 * (epubier's `comicArchive.workerUrl`) rather than from a CDN.
 */
function epubierAssets(): Plugin {
  const root = fileURLToPath(new URL('dist/', import.meta.resolve('epubier/package.json')));
  const files = ['comicarchive.worker.js', 'libarchive.wasm'];
  return {
    name: 'nexlibris-epubier-assets',
    configureServer(server) {
      server.middlewares.use('/epubier/', (req, res, next) => {
        const file = decodeURIComponent(req.url?.split('?')[0] ?? '').replace(/^\//, '');
        if (!files.includes(file)) return next();
        res.setHeader('Content-Type', file.endsWith('.wasm') ? 'application/wasm' : 'text/javascript');
        res.end(readFileSync(join(root, file)));
      });
    },
    generateBundle() {
      for (const file of files) this.emitFile({ type: 'asset', fileName: `epubier/${file}`, source: readFileSync(join(root, file)) });
    },
  };
}

/**
 * rtf.js's own build carries the codepage package's tables for 140 code pages (2mb), when RTF uses a few dozen. The
 * build compiles rtf.js from its TypeScript source instead, with just the single-byte code pages RTF documents name,
 * as epubier's self-contained script does. The Japanese, Chinese and Korean ones would add some 750kb, so those,
 * and any other, read as Windows-1252: only old RTF that writes such text as code-page bytes, rather than `\u`
 * escapes, comes out wrong. Not for the dev server or tests, which keep rtf.js's own build.
 */
function rtfCodepages(): Plugin {
  const codepages = [
    437, 850, 874, 1250, 1251, 1252, 1253, 1254, 1255, 1256, 1257, 1258, 10000, 10004, 10005, 10006, 10007, 10021,
    10029, 10081,
  ];
  const rtfPackage = import.meta.resolve('rtf.js/package.json');
  const src = fileURLToPath(new URL('src/', rtfPackage));
  const tablesId = '\0nexlibris-rtf-codepages';
  return {
    name: 'nexlibris-rtf-codepages',
    apply: 'build',
    enforce: 'pre',
    resolveId(id, importer) {
      if (id === 'rtf.js') return join(src, 'index.ts');
      if (!importer?.startsWith(src)) return null;
      if (id === 'EMFJS' || id === 'WMFJS') return join(src, id.toLowerCase(), 'index.ts');
      if (id === 'codepage') return tablesId;
      return null;
    },
    // Its entry points re-export interfaces as if they were values, which tsc and esbuild drop and rolldown doesn't.
    transform(code, id) {
      if (!id.startsWith(src) || !id.endsWith('index.ts')) return null;
      return code.replace(/, (ISettings|IRendererSettings) \}/, ', type $1 }');
    },
    load(id) {
      if (id !== tablesId) return null;
      const cptable = createRequire(rtfPackage)('codepage/cptable.js') as Record<number, { dec: Record<number, string> }>;
      // A single-byte code page's characters as a string indexed by byte, as rtf.js indexes `dec`.
      const tables = Object.fromEntries(
        codepages.map((cp) => [cp, Array.from({ length: 256 }, (_, i) => cptable[cp]?.dec[i] ?? '�').join('')]),
      );
      return `const tables = ${JSON.stringify(tables)};
export default new Proxy({}, { get: (_, cp) => ({ dec: tables[cp] || tables[1252] }) });`;
    },
  };
}

export default defineConfig({
  // Where the app is served from: `/` everywhere but a static host's subfolder, such as GitHub Pages'
  // `/nexlibris/` (`NEXLIBRIS_BASE=/nexlibris/ npm run build -w client`).
  base: process.env.NEXLIBRIS_BASE || '/',
  plugins: [react(), pdfjsAssets(), epubierAssets(), rtfCodepages()],
  // One copy of each, epubier's too (and when it's linked from ../../epubierjs, which has its own for development).
  resolve: { dedupe: ['epubjs', 'pdfjs-dist', '@lingo-reader/mobi-parser', 'jszip', 'rtf.js'] },
  // `NEXLIBRIS_SERVER=http://localhost:8080 npm run dev`: the dev server passes the API on to a nexlibris server (M4).
  // The Host header stays the page's, which the server checks calls against.
  ...(process.env.NEXLIBRIS_SERVER && { server: { proxy: { '/api': { target: process.env.NEXLIBRIS_SERVER } } } }),
  // Module workers, so a worker's dynamic imports stay separate files (the text worker never loads pdf.js).
  worker: { format: 'es', plugins: () => [rtfCodepages()] },
  optimizeDeps: {
    // Bundled up front; estuary-rpc's dist/ is CommonJS, which doesn't load in the page unbundled.
    include: ['epubier/all', 'estuary-rpc', 'estuary-rpc-client'],
  },
  test: {
    environment: 'happy-dom',
    // Plugins' formats, registered as the app's entry points do.
    setupFiles: ['src/plugins/formats.ts'],
    environmentOptions: {
      happyDOM: {
        // Tests parse untrusted and book HTML; like DOMParser in a browser, don't fetch what it links to.
        settings: {
          disableCSSFileLoading: true,
          disableJavaScriptFileLoading: true,
          disableIframePageLoading: true,
          handleDisabledFileLoadingAsSuccess: true,
        },
      },
    },
  },
});
