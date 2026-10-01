# nexlibris

Calibre-like library manager. [PLAN.md](PLAN.md) holds the vision, guiding decisions and milestones (M0–M7); keep it current when scope or decisions change.

## Layout

- `common/` (`@nexlibris/common`): the library model, shared by every frontend and backend.
  - `types.ts` schema; `operations.ts` typed operations and the pure `applyOperation` reducer; `backend.ts` `LibraryBackend` and `StoredLibraryBackend` (library JSON + change log + content-addressed files on any `Storage`).
  - `storage.ts` the `Storage` interface (`MemoryStorage` for tests).
  - `storageApi.ts` the Storage API defined with estuary-rpc; `rpc.ts` estuary-rpc over a message channel; `rpcStorage.ts` `Storage` over that API (base64 chunks).
- `client/` (`@nexlibris/client`): React + Vite web app.
  - `backends/` OPFS storage (browser) and the Android bridge. `library/LibraryContext.tsx` picks one: the bridge when `window.NexlibrisAndroid` exists, otherwise OPFS.
  - `formats/` metadata extraction per format (EPUB, MOBI/AZW3, PDF, TXT/RTF, CBZ/CBR) and `formats/convert/` in-browser conversion.
  - `reader/` in-app viewers; `components/` UI; `styles/` theme and shared styled components.
- `android/`: Kotlin WebView shell. Serves `client/dist` from assets at `https://appassets.androidplatform.net` and implements the Storage API natively (`StorageService`, `StorageRouter`, `NativeBridge`). Library logic stays in TypeScript.
- `server/`: placeholder for M4.

## Commands

Run from the repo root (Node 24 via nvm; in a non-login shell, put `~/.nvm/versions/node/v24*/bin` on PATH).

- `npm test`, `npm run typecheck`, `npm run build`, `npm run dev`. Run all three of test/typecheck/build before calling work done.
- Single workspace: `npm test -w client`, or `npx vitest run src/path` inside a workspace.
- Android: `npm run android`; native tests `cd android && ./gradlew testDebugUnitTest lintDebug`. Needs `JAVA_HOME` set to Android Studio's JBR (the system Java is 8) and `android/local.properties` with `sdk.dir`. Builds use compileSdk 36 and build-tools 36.1.0; newer AndroidX releases need AGP 9 / API 37.

## Conventions

- Mutate libraries only through operations; never edit `Library` objects directly in the UI.
- Prefer TypeScript implementations of format parsing and conversion that run in the browser.
- Styling uses styled-components with transient `$props`; theme values are CSS variables in `styles/GlobalStyle.ts`. Reuse `styles/ui.ts` before adding new primitives. No CSS files.
- Book HTML (descriptions, EPUB content) is untrusted: render it with `RichText`, which rebuilds allowlisted tags as React elements. Never use `dangerouslySetInnerHTML`.
- Tests run in happy-dom with resource loading disabled (`client/vite.config.ts`); keep it that way so tests never hit the network. Sample books live in `client/src/formats/fixtures/`.
- Code style: single quotes, 120-column lines (`prettier --single-quote --print-width 120` if formatting).
- Any change to the Storage API must be made in both `common/src/storageApi.ts` and `android/.../StorageRouter.kt`/`StorageService.kt`, with tests on both sides.

## Dependencies to know about

- `epubier` is linked from `../epubierjs` (`file:` dependency), which must be checked out next to this repo.
- `estuary-rpc` is the published 1.0.6, older than the `~/dev/estuary-rpc` source (no `ApiTypeOf`), which is why `rpc.ts` defines its own client types.
