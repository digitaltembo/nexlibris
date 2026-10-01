// Launches the desktop app from the repo: `npm start -w desktop [-- electron args]`.
//
// On macOS the menu bar and Dock name an app after its bundle, which is Electron's own
// `Electron.app` when running unpackaged. So this runs a copy named nexlibris.app (an instant
// APFS clone where possible) with its name, identifier and icon changed, made again whenever
// Electron or the icon changes. Elsewhere it runs Electron as it is.
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const desktop = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const electron = require('electron'); // The path of Electron's executable.
const args = [desktop, ...process.argv.slice(2)];

function macApp() {
  const source = join(dirname(electron), '..', '..'); // …/Electron.app
  const icon = join(desktop, 'assets', 'icon.icns');
  const bundle = join(desktop, '.app', 'nexlibris.app');
  const stamp = join(desktop, '.app', 'stamp.json');
  // `bundle` changes whenever what's done to the copy below does, so older copies are made again.
  const want = JSON.stringify({ bundle: 2, electron: require('electron/package.json').version, icon: statSync(icon).mtimeMs });
  if (!existsSync(stamp) || readFileSync(stamp, 'utf8') !== want || !existsSync(bundle)) {
    rmSync(bundle, { recursive: true, force: true });
    mkdirSync(dirname(bundle), { recursive: true });
    try {
      execFileSync('cp', ['-cR', source, bundle]); // A clone on APFS: no extra space.
    } catch {
      execFileSync('cp', ['-R', source, bundle]);
    }
    const plist = join(bundle, 'Contents', 'Info.plist');
    for (const [key, value] of [
      ['CFBundleName', 'nexlibris'],
      ['CFBundleDisplayName', 'nexlibris'],
      ['CFBundleIdentifier', 'org.nexlibris.desktop'],
      // Shown when macOS first asks for the camera.
      ['NSCameraUsageDescription', 'nexlibris uses the camera to scan the ISBN barcodes on books.'],
    ]) {
      execFileSync('plutil', ['-replace', key, '-string', value, plist]);
    }
    execFileSync('cp', [icon, join(bundle, 'Contents', 'Resources', 'electron.icns')]);
    // Editing the bundle breaks Electron's signature; sign it again, ad hoc, so macOS runs it.
    execFileSync('codesign', ['--force', '--deep', '--sign', '-', bundle], { stdio: 'ignore' });
    writeFileSync(stamp, want);
  }
  return join(bundle, 'Contents', 'MacOS', 'Electron');
}

const executable = process.platform === 'darwin' ? macApp() : electron;
const child = spawn(executable, args, { stdio: 'inherit' });
child.on('exit', (code, signal) => process.exit(signal ? 1 : (code ?? 0)));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
