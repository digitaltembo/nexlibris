# nexlibris

A library manager for ebooks (and later other media) that runs in the browser, on the desktop (Electron) and on Android. Early work in progress; see [PLAN.md](PLAN.md).

## Setup

Needs Node 24 (`nvm use`) and a sibling checkout of [epubierjs](../epubierjs) at `../epubierjs`.

```sh
npm install
```

## Commands

```sh
npm run dev          # web app at http://localhost:5173
npm run build        # web app → client/dist, and the desktop app's main process → desktop/dist
npm run desktop      # build, then run the desktop app (see below)
npm test             # all workspaces
npm run typecheck

npm run android          # debug APK (android/app/build/outputs/apk/debug)
npm run android:install  # build and install on a connected device
```

The Android build needs the Android SDK and JDK 17+ (e.g. `export JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home"`). Native unit tests: `cd android && ./gradlew testDebugUnitTest`.

## Desktop app (Electron)

The desktop app (`desktop/`) runs the same web client in an Electron window, with the library stored as plain files on disk instead of in the browser.

First time only: npm may skip Electron's download script, leaving it without its binary. Fetch it with:

```sh
node node_modules/electron/install.js
```

Build and launch:

```sh
npm run desktop              # builds the web client and the main process, then launches
```

Once built, the pieces can be rebuilt and launched separately:

```sh
npm run build -w client      # after changing the web client (the app serves client/dist; there's no hot reload)
npm run build -w desktop     # after changing desktop/src (main process and preload → desktop/dist)
npm start -w desktop         # launch without rebuilding
```

On macOS, `npm start` runs a copy of Electron renamed to nexlibris (`desktop/.app/nexlibris.app`, an APFS clone of `Electron.app` with nexlibris's name and icon), so the menu bar and Dock say nexlibris rather than Electron. It's made on first launch and again when Electron or the icon changes.

Options:

```sh
NEXLIBRIS_LIBRARY_DIR=~/Books/nexlibris npm start -w desktop    # use another library folder
npm start -w desktop -- --remote-debugging-port=9333              # attach Chrome DevTools at http://localhost:9333
```

The library lives in `<userData>/library` by default (on macOS, `~/Library/Application Support/nexlibris/library`). It isn't packaged as an installable app yet; it runs from the repo.
