import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Window } from 'happy-dom';
import { installCanvas } from './canvas';

/**
 * What the tools expect of a browser, under Node: a DOM for reading and writing XML and HTML
 * (happy-dom's, which loads nothing a document links to), and `fetch` of local files, which is how
 * they load bundled assets (unrar's wasm, pdf.js's worker) and the Kindle parser's resources, kept
 * on disk under Node; and a canvas, Skia's (`canvas.ts`). Imported before anything else.
 */

const window = new Window({
  settings: {
    disableJavaScriptFileLoading: true,
    disableCSSFileLoading: true,
    disableIframePageLoading: true,
    handleDisabledFileLoadingAsSuccess: true,
  },
});
Object.assign(globalThis, { DOMParser: window.DOMParser, XMLSerializer: window.XMLSerializer, Node: window.Node, document: window.document });
installCanvas(window.document);

const webFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  // A file: URL, or a path (anything without a scheme).
  const path = url.startsWith('file:') ? fileURLToPath(url) : /^[a-z][a-z\d+.-]*:/i.test(url) ? undefined : url;
  return path === undefined ? webFetch(input, init) : new Response(new Uint8Array(await readFile(path)));
};
