#!/usr/bin/env node
/**
 * Stamps a release's version on everything that carries one, from its tag (`v1.2.3`, `v1.2.3-beta.1`):
 * every workspace's package.json (and their dependencies on each other), the Tauri app's
 * tauri.conf.json and Cargo.toml (without a pre-release part). The Android and iOS builds take theirs as
 * arguments, which this prints for GitHub Actions (`>> $GITHUB_OUTPUT`) as `key=value` lines:
 *
 *   version        1.2.3-beta.1   npm and Android's versionName
 *   marketing      1.2.3          iOS's MARKETING_VERSION and the Tauri app's (Windows installers take no
 *                                 pre-release part, so neither does the desktop app)
 *   code           1002003        Android's versionCode and iOS's build number: major·1e6 + minor·1e3 + patch,
 *                                 so it rises with every release (a pre-release shares its release's)
 *   npmTag         latest | next  the npm dist-tag: pre-releases go to `next`
 *
 * Nothing is committed: CI stamps its checkout. `--check` only prints.
 *
 *   node scripts/release/version.mjs v1.2.3 [--check]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const [tag, flag] = process.argv.slice(2);
const match = /^v?(\d+)\.(\d+)\.(\d+)(-[0-9A-Za-z.-]+)?$/.exec(tag ?? '');
if (!match) {
  console.error(`Not a release version: ${tag ?? '(none)'}. Tag releases v<major>.<minor>.<patch>, e.g. v0.3.0 or v0.3.0-beta.1.`);
  process.exit(1);
}
const [, major, minor, patch, pre = ''] = match;
if (+minor > 999 || +patch > 999) {
  console.error('Minor and patch versions above 999 don’t fit the Android version code.');
  process.exit(1);
}
const version = `${major}.${minor}.${patch}${pre}`;
const out = {
  version,
  marketing: `${major}.${minor}.${patch}`,
  code: String(+major * 1_000_000 + +minor * 1_000 + +patch),
  npmTag: pre ? 'next' : 'latest',
};

if (flag !== '--check') {
  const rootPackage = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  for (const workspace of rootPackage.workspaces) {
    const file = join(root, workspace, 'package.json');
    const pkg = JSON.parse(readFileSync(file, 'utf8'));
    pkg.version = version;
    for (const field of ['dependencies', 'devDependencies', 'peerDependencies']) {
      for (const name of Object.keys(pkg[field] ?? {})) if (name.startsWith('@nexlibris/')) pkg[field][name] = version;
    }
    writeFileSync(file, `${JSON.stringify(pkg, null, 2)}\n`);
  }

  const tauriConf = join(root, 'tauri/src-tauri/tauri.conf.json');
  const conf = JSON.parse(readFileSync(tauriConf, 'utf8'));
  conf.version = out.marketing;
  writeFileSync(tauriConf, `${JSON.stringify(conf, null, 2)}\n`);

  const cargo = join(root, 'tauri/src-tauri/Cargo.toml');
  writeFileSync(cargo, readFileSync(cargo, 'utf8').replace(/^version = ".*"$/m, `version = "${out.marketing}"`));
}

for (const [key, value] of Object.entries(out)) console.log(`${key}=${value}`);
