/**
 * How the CLI loads what the tools import the way a browser build does, shared by its bundle
 * (`rolldown.config.js`) and its tests (`vite.config.ts`), so the tests run what the CLI runs.
 */

/** pdf.js's builds for browsers need what Node lacks (`Uint8Array.prototype.toHex`); its legacy build is the one for Node. */
export const forNode = (id: string) =>
  id.replace(/^pdfjs-dist\/build\//, 'pdfjs-dist/legacy/build/').replace(/^pdfjs-dist$/, 'pdfjs-dist/legacy/build/pdf.mjs');

/**
 * Vite's asset URLs (`import url from 'pkg/file?url'`), which the tools use for unrar's wasm and
 * pdf.js's worker: the file's URL in node_modules, resolved when the CLI runs (`now` false, for its
 * bundle) or now (for its tests, where a virtual module has no place to resolve from).
 */
export const assetUrls = ({ now = false } = {}) => ({
  name: 'asset-urls',
  enforce: 'pre' as const,
  resolveId: (id: string) => (id.endsWith('?url') ? `\0url:${forNode(id.slice(0, -'?url'.length))}` : undefined),
  load: (id: string) => {
    if (!id.startsWith('\0url:')) return undefined;
    const spec = id.slice('\0url:'.length);
    return `export default ${now ? JSON.stringify(import.meta.resolve(spec)) : `import.meta.resolve(${JSON.stringify(spec)})`};`;
  },
});

/** pdf.js as its legacy build, loaded from node_modules. */
export const nodeBuilds = {
  name: 'node-builds',
  enforce: 'pre' as const,
  resolveId: (id: string) => (/^pdfjs-dist(\/build\/|$)/.test(id) && !id.endsWith('?url') ? { id: forNode(id), external: true } : undefined),
};
