import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  // `NEXLIBRIS_SERVER=http://localhost:8080 npm run dev`: the dev server passes the API on to a nexlibris server (M4).
  // The Host header stays the page's, which the server checks calls against.
  ...(process.env.NEXLIBRIS_SERVER && { server: { proxy: { '/api': { target: process.env.NEXLIBRIS_SERVER } } } }),
  // Module workers, so a worker's dynamic imports stay separate files (the text worker never loads pdf.js).
  worker: { format: 'es' },
  optimizeDeps: {
    // Linked from ../../epubierjs and ../../estuary-rpc, which Vite would otherwise serve unbundled from outside the
    // workspace (estuary-rpc's CommonJS doesn't load in the page that way).
    include: ['epubier', 'estuary-rpc', 'estuary-rpc-client'],
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
