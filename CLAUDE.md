# nexlibris

Calibre-like library manager. [PLAN.md](PLAN.md) holds the vision, guiding decisions and milestones (M0–M7); keep it current when scope or decisions change. Its **TLDR** section (status table and next steps) must be updated in the same change whenever work moves a milestone forward.

## Layout

- `common/` (`@nexlibris/common`): the library model, shared by every frontend and backend.
  - `types.ts` schema; `operations.ts` typed operations and the pure `applyOperation` reducer; `backend.ts` `LibraryBackend` and `StoredLibraryBackend` (library JSON + change log + content-addressed files on any `Storage`).
  - `storage.ts` the `Storage` interface (`MemoryStorage` for tests).
  - `storageApi.ts` the Storage API defined with estuary-rpc; `saveApi.ts` saving files out of the app; `importApi.ts` native file picking for import (the app stores picked files itself); `rpc.ts` estuary-rpc over a message channel; `rpcStorage.ts` `Storage` over that API (base64 chunks).
- `client/` (`@nexlibris/client`): React + Vite web app.
  - `backends/` OPFS storage (browser) and the Android and desktop bridges. `library/LibraryContext.tsx` picks one: the native app's storage when there's a transport (`backends/native.ts`: Android's bridge or the desktop app's `window.NexlibrisDesktop`), otherwise OPFS. In both apps `NativeStorage` reads stored files by fetching `/library/files/…`, which the app serves; everything else goes over the transport.
  - `formats/` metadata extraction per format (EPUB, MOBI/AZW3, PDF, TXT/RTF, CBZ/CBR) and `formats/convert/` in-browser conversion. `formats/convert/xteink/` is the CrossPoint X4/X3 optimizer, a port of the Python in `~/dev/crosspoint/calibre-plugins/crosspoint_reader/` (keep it in step with `optimizer.py`/`textsplit.py`); its options live in `xteink/options.ts` and are part of the converter version.
  - `isbn/` ISBN checking, Open Library lookup and barcode reading (native `BarcodeDetector`, else zxing-wasm, whose wasm is bundled rather than fetched from its CDN); the "Add by ISBN" UI is `components/IsbnDialog.tsx`.
  - `devices/` device plugin points and the sync planner/runner, and `devices/opds/` the OPDS catalog export (calibre3opds's layout); `plugins/` built-in plugins (`crosspoint/`: X4/X3 device types and the CrossPoint web API client).
  - `library/search.ts` the search syntax (Gmail-style `field:value` terms, `or`, `has:`; documented at its top) used by the search box, filters and device rules; `library/filters.ts` filters as rules (what `components/FiltersDialog.tsx` edits), converted to and from that syntax.
  - `reader/` in-app viewers; `components/` UI; `styles/` theme and shared styled components.
- `android/`: Kotlin WebView shell. Serves `client/dist` from assets at `https://appassets.androidplatform.net` and implements the Storage, Save and Import APIs natively (`StorageService`, `SaveService`, `ImportService`, `RpcRouter`, `NativeBridge`, a `WebViewCompat` web message listener limited to the app's origin); the camera, for ISBN scanning, is granted only to the app's own pages. Library logic stays in TypeScript.
- `desktop/`: Electron shell. Serves `client/dist` at `app://nexlibris/` and implements the Storage, Save and Import APIs in the main process over native files (`fileStorage.ts`, `saveService.ts`, `importService.ts`, served with `createMessageHandler`); the preload exposes one IPC call, `window.NexlibrisDesktop.rpc`. Stored files are read from `app://nexlibris/library/files/…`, as on Android. Bundled with rolldown (`dist/main.js`, `dist/preload.cjs`). `npm start -w desktop` runs `scripts/start.js`, which on macOS launches a renamed copy of Electron (`desktop/.app/nexlibris.app`, ignored by git) so the app shows as nexlibris; `productName` in `desktop/package.json` sets the app name and so its data folder.
- `server/`: placeholder for M4.
- `icon.png` is the source of every app icon. After changing it, run `python3 scripts/make-icons.py` (needs Pillow): it writes the squircle favicons (`client/public/`), the desktop icon (`desktop/assets/icon.png`) and the Android launcher icons (`android/.../res/mipmap-*`).

## Commands

Run from the repo root (Node 24 via nvm; in a non-login shell, put `~/.nvm/versions/node/v24*/bin` on PATH).

- `npm test`, `npm run typecheck`, `npm run lint`, `npm run build`, `npm run dev`. Run test, typecheck, lint and build before calling work done.
- Lint is oxlint (`.oxlintrc.json`), not ESLint: typescript-eslint doesn't support TypeScript 7. Rules that only flag idioms used on purpose here are off in the config, with the reason; a one-off exception gets `// oxlint-disable-next-line <rule> -- why`.
- Single workspace: `npm test -w client`, or `npx vitest run src/path` inside a workspace.
- Desktop: `npm run desktop` (builds, then runs Electron). `NEXLIBRIS_LIBRARY_DIR` picks the library folder. npm may skip Electron's install script; then run `node node_modules/electron/install.js`.
- Android: `npm run android`; native tests `cd android && ./gradlew testDebugUnitTest lintDebug`. Needs `JAVA_HOME` set to Android Studio's JBR (the system Java is 8) and `android/local.properties` with `sdk.dir`. Builds use compileSdk 36 and build-tools 36.1.0; newer AndroidX releases need AGP 9 / API 37.

## Conventions

- Mutate libraries only through operations; never edit `Library` objects directly in the UI.
- Changing the stored shape of a library (types in `common/src/types.ts`, or an operation's shape) means bumping `SCHEMA_VERSION` and adding a step to `MIGRATIONS` in `common/src/migrate.ts`, with a test.
- Prefer TypeScript implementations of format parsing and conversion that run in the browser.
- Styling uses styled-components with transient `$props`; theme values are CSS variables in `styles/GlobalStyle.ts`. Reuse `styles/ui.ts` before adding new primitives. No CSS files.
- Book HTML (descriptions, EPUB content) is untrusted: render it with `RichText`, which rebuilds allowlisted tags as React elements. Never use `dangerouslySetInnerHTML`.
- Tests run in happy-dom with resource loading disabled (`client/vite.config.ts`); keep it that way so tests never hit the network. Sample books live in `client/src/formats/fixtures/`. happy-dom differs from browsers: parse XML with `formats/xml.ts` (happy-dom rejects some valid XML declarations), and mock the Kindle parser in import tests (under Node it fetches resources and writes to disk).
- Code style: single quotes, lines around 120 columns (some run longer). There's no formatter config, so don't run Prettier over whole files: it rewraps untouched code. Format only what you write, by hand or on a scratch copy.
- Any change to the Storage, Save or Import API must be made in `common/src/storageApi.ts`/`saveApi.ts`/`importApi.ts`, `android/.../RpcRouter.kt` plus `StorageService.kt`/`SaveService.kt`/`ImportService.kt`, and `desktop/src/fileStorage.ts`/`saveService.ts`/`importService.ts`, with tests on every side.
- Save files out of the app with `client/src/library/saveFile.ts`, not `<a download>` alone: downloads do nothing in the Android WebView. For big files use `saveParts` (the backup does, with `library/zip.ts`), and call it before awaiting anything so Chrome's save picker still has the click's user activation.

## Dependencies to know about

- `epubier` is linked from `../epubierjs` (`file:` dependency), which must be checked out next to this repo. nexlibris uses its built `dist/`, so run `npm run build` there after changing it. Its `position` and `onLocationChange` options exist for nexlibris's reading positions, and `replacements: 'base64'` for opening image-heavy books quickly in the Android WebView; `src/patches.js` there fixes epub.js's base64 mode.
- `estuary-rpc` is the published 1.0.6, older than the `~/dev/estuary-rpc` source (no `ApiTypeOf`), which is why `rpc.ts` defines its own client types.
