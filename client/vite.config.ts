import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  optimizeDeps: {
    // Linked from ../../epubierjs, which Vite would otherwise serve unbundled from outside the workspace.
    include: ['epubier'],
  },
  test: {
    environment: 'happy-dom',
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
