#!/usr/bin/env node
/**
 * The npm packages, packed into dist-npm/ (and, with `--publish`, published from there):
 *
 * - `@nexlibris/tools` and `@nexlibris/crosspoint-tools`, compiled: in the workspace their `exports` are
 *   TypeScript source, which other projects can't load. Each module becomes its own .js (by rolldown, keeping
 *   modules apart, so heavy ones still load only where they're used) with its .d.ts (by tsc), under the same
 *   paths (`@nexlibris/tools/formats/parseFile`). Like the app they're written for a bundler: they import
 *   assets as Vite does (`pdfjs-dist/build/pdf.worker.min.mjs?url`).
 * - `@nexlibris/cli`, the `nexlibris` command: its bundle (`npm run build -w cli` first), which holds the
 *   tools, so it depends on what they depend on rather than on them.
 * - `@nexlibris/server`, the `nexlibris-server` command: its bundle, which depends on nothing, with the web app
 *   it serves beside it as `client/` (`npm run build -w client && npm run build -w server` first; the web app
 *   built as usual, for `/` and with a server, not as GitHub Pages' is).
 *
 * Run after `node scripts/release/version.mjs <tag>`, which gives them the release's version.
 *
 *   node scripts/release/npm.mjs [--publish] [--tag latest|next]
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'rolldown';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const out = join(root, 'dist-npm');
const args = process.argv.slice(2);
const publish = args.includes('--publish');
const tag = args.includes('--tag') ? args[args.indexOf('--tag') + 1] : 'latest';

const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));
const writeJson = (file, value) => writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
const rootPackage = readJson(join(root, 'package.json'));
const repository = { type: 'git', url: 'git+https://github.com/digitaltembo/nexlibris.git' };

/** What every published package says besides its own fields. */
const common = (pkg, directory) => ({
  name: pkg.name,
  version: pkg.version,
  description: pkg.description,
  license: 'MIT',
  repository: { ...repository, directory },
  homepage: `https://github.com/digitaltembo/nexlibris/tree/main/${directory}#readme`,
  type: 'module',
});

/** The source modules a package publishes: everything in src/ but tests and their fixtures. */
function modules(src) {
  const found = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== 'fixtures') walk(path);
      } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') && !entry.name.endsWith('.d.ts')) {
        found.push(path);
      }
    }
  };
  walk(src);
  return found;
}

/** A library package (tools, crosspoint-tools), compiled module by module. */
async function packLibrary(directory) {
  const dir = join(root, directory);
  const pkg = readJson(join(dir, 'package.json'));
  const target = join(out, directory);
  const src = join(dir, 'src');
  const files = modules(src);

  await build({
    input: Object.fromEntries(files.map((file) => [relative(src, file).replace(/\.ts$/, ''), file])),
    // Only its own modules are compiled; packages (other nexlibris ones too) and assets stay imports.
    external: (id) => !id.startsWith('.') && !isAbsolute(id),
    output: { dir: target, format: 'esm', preserveModules: true, preserveModulesRoot: src, entryFileNames: '[name].js' },
    logLevel: 'warn',
  });

  // Declarations by tsc, from a tsconfig beside the package's own (its `include` would take its tests).
  const tsconfig = join(dir, 'tsconfig.npm.json');
  writeJson(tsconfig, {
    extends: './tsconfig.json',
    compilerOptions: { noEmit: false, declaration: true, emitDeclarationOnly: true, rootDir: 'src', outDir: target },
    files: files.map((file) => relative(dir, file)),
    include: [],
  });
  try {
    execFileSync(join(root, 'node_modules/.bin/tsc'), ['-p', tsconfig], { stdio: 'inherit' });
  } finally {
    rmSync(tsconfig);
  }

  writeJson(join(target, 'package.json'), {
    ...common(pkg, directory),
    exports: { './*': { types: './*.d.ts', default: './*.js' } },
    dependencies: pkg.dependencies,
  });
  copyFileSync(join(dir, 'README.md'), join(target, 'README.md'));
  copyFileSync(join(root, 'LICENSE'), join(target, 'LICENSE'));
}

/** The CLI: its bundle, with the dependencies of everything bundled into it. */
function packCli() {
  const dir = join(root, 'cli');
  const pkg = readJson(join(dir, 'package.json'));
  const bundle = join(dir, 'dist/main.js');
  if (!existsSync(bundle)) throw new Error('No CLI bundle: run `npm run build -w cli` first.');
  const target = join(out, 'cli');
  mkdirSync(join(target, 'dist'), { recursive: true });
  copyFileSync(bundle, join(target, 'dist/main.js'));

  const dependencies = {};
  for (const directory of ['tools', 'crosspoint-tools', 'cli']) {
    for (const [name, range] of Object.entries(readJson(join(root, directory, 'package.json')).dependencies ?? {})) {
      if (!name.startsWith('@nexlibris/')) dependencies[name] = range;
    }
  }
  writeJson(join(target, 'package.json'), {
    ...common(pkg, 'cli'),
    bin: { nexlibris: 'dist/main.js' },
    files: ['dist'],
    engines: { node: '>=24' },
    dependencies: Object.fromEntries(Object.entries(dependencies).sort(([a], [b]) => a.localeCompare(b))),
  });
  copyFileSync(join(dir, 'README.md'), join(target, 'README.md'));
  copyFileSync(join(root, 'LICENSE'), join(target, 'LICENSE'));
}

/** The server: its bundle, which needs no packages, and the web app it serves. */
function packServer() {
  const dir = join(root, 'server');
  const pkg = readJson(join(dir, 'package.json'));
  const bundle = join(dir, 'dist/main.js');
  const client = join(root, 'client/dist');
  if (!existsSync(bundle)) throw new Error('No server bundle: run `npm run build -w server` first.');
  if (!existsSync(join(client, 'index.html'))) throw new Error('No web app: run `npm run build -w client` first.');
  if (!readFileSync(join(client, 'index.html'), 'utf8').includes('src="/assets/')) {
    throw new Error('client/dist is built for somewhere other than /: build it again without NEXLIBRIS_BASE.');
  }
  const target = join(out, 'server');
  mkdirSync(join(target, 'dist'), { recursive: true });
  copyFileSync(bundle, join(target, 'dist/main.js'));
  cpSync(client, join(target, 'client'), { recursive: true });
  writeJson(join(target, 'package.json'), {
    ...common(pkg, 'server'),
    bin: { 'nexlibris-server': 'dist/main.js' },
    files: ['dist', 'client'],
    engines: { node: '>=24' },
  });
  copyFileSync(join(dir, 'README.md'), join(target, 'README.md'));
  copyFileSync(join(root, 'LICENSE'), join(target, 'LICENSE'));
}

/** Publishes a packed package, unless its version is out already (a re-run release). */
function publishPackage(directory) {
  const { name, version } = readJson(join(out, directory, 'package.json'));
  try {
    execFileSync('npm', ['view', `${name}@${version}`, 'version'], { stdio: 'pipe' });
    console.log(`${name}@${version} is published already.`);
    return;
  } catch {
    // Not published yet.
  }
  const provenance = process.env.GITHUB_ACTIONS ? ['--provenance'] : [];
  execFileSync('npm', ['publish', join(out, directory), '--access', 'public', '--tag', tag, ...provenance], { stdio: 'inherit' });
}

rmSync(out, { recursive: true, force: true });
const packages = ['tools', 'crosspoint-tools', 'cli', 'server'];
if (!packages.every((directory) => rootPackage.workspaces.includes(directory))) throw new Error('A package moved.');
await packLibrary('tools');
await packLibrary('crosspoint-tools');
packCli();
packServer();
for (const directory of packages) {
  execFileSync('npm', ['pack', '--dry-run', join(out, directory)], { stdio: 'inherit' });
  if (publish) publishPackage(directory);
}
