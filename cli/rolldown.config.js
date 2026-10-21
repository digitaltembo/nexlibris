import { builtinModules } from 'node:module';
import { defineConfig } from 'rolldown';
import { assetUrls, nodeBuilds } from './nodeBuilds.ts';

/**
 * Packages load from node_modules when the CLI runs; only nexlibris's own, TypeScript source, are bundled, and
 * rtf.js, whose entry imports its bundle without an extension, which Node's loader won't find. pdf.js is left to
 * `nodeBuilds`, which makes it external as its legacy build.
 */
const external = (id) =>
  builtinModules.includes(id) ||
  id.startsWith('node:') ||
  (/^[@a-z]/i.test(id) && !id.startsWith('@nexlibris/') && !/^(rtf\.js|pdfjs-dist)/.test(id) && !id.endsWith('?url'));

export default defineConfig({
  input: 'src/main.ts',
  platform: 'node',
  external,
  plugins: [assetUrls(), nodeBuilds],
  output: { file: 'dist/main.js', format: 'esm', codeSplitting: false, banner: '#!/usr/bin/env node' },
});
