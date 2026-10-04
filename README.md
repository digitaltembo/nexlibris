# nexlibris

A library manager for ebooks (and later other media) that runs in the browser, on the desktop (Electron) and on Android. Early work in progress; see [PLAN.md](PLAN.md) for what's next.

## Architecture

One React web app runs everywhere. Each platform supplies only storage and a few native services; all library logic is shared TypeScript.

```
common/    the library model, operations, storage interface, sync      (shared by everything)
client/    React + Vite web app: UI, formats, conversion, devices, search
desktop/   Electron shell: serves client/dist, native files, LAN sync hub
android/   Kotlin WebView shell: serves client/dist, native files, Bluetooth/USB sync
server/    placeholder for a Node backend (M4)
```

### The library

- **A library is one JSON document** (`common/src/types.ts`): items, per-user data (ratings, reviews, reading positions), devices and browse categories.
  - An item has a title, creators, tags, identifiers, metadata and zero or more files, so a book can be catalogued without owning a file.
  - Metadata is a `BookMetadata` (`common/src/metadata.ts` normalizes it): the fields Calibre and EPUB know (subtitle, title and author sort, series, publisher, language, rights, pages, description), the edition's publication date and the work's original one (`originallyPublished`, which the library sorts by), and the cover's main colour. Other keys are custom fields. Dates are partial ISO dates (`1965`, `1965-08`, `1965-08-01`).
  - It carries a `schemaVersion`, and older libraries are migrated on load (`common/src/migrate.ts`).
- **It changes only through operations** (`common/src/operations.ts`). These are typed changes such as `addItem`, `attachFile`, `addTags` or `setRating`, applied by a pure reducer.
  - Each applied operation is appended to a change log with a revision, and the instance's `origin` and a sequence number.
  - The UI never edits library objects directly.
- **Files are content-addressed.** They're stored by SHA-256 at `files/<ab>/<hash>`, so duplicates and integrity checks come free. A converted file records what it was derived from and by which converter version, so it's remade when either changes.
- **Instance-local state** lives under `local/`. It's never synced or backed up, and holds sync pairings, the full-text index and cover thumbnails.

### Backends and storage

- **One backend for every platform:** `StoredLibraryBackend` (`common/src/backend.ts`) keeps the library JSON, the change log and the files on any `Storage`.
- **Each platform supplies the storage:**
  - **Browser:** OPFS (`client/src/backends/opfsStorage.ts`).
  - **Desktop and Android:** the app's native files.
    - The page calls them through the Storage, Save and Import APIs (`common/src/storageApi.ts` and its siblings), defined with [estuary-rpc](https://github.com/digitaltembo/estuary-rpc) over a message channel.
    - The desktop app serves them from its main process; the Android app from Kotlin services behind a WebView message listener.
    - Stored files are read by plain `fetch` from paths the app serves (`/library/files/…`), so large files never cross the bridge.

### The client

- **Formats** (`client/src/formats/`): metadata extraction for EPUB, MOBI/AZW3, PDF, TXT/RTF and CBZ/CBR. In-browser conversion, including the CrossPoint X4/X3 optimizer, a TS port of the Calibre plugin.
- **Import** (`library/importFiles.ts`): files, folders and whole Calibre libraries. It groups formats of one book together and matches books already in the library.
- **Search** (`library/search.ts`): a Gmail-style syntax (`tag:fantasy rating:4+ -has:file`). Filters, device selections and browse categories are all stored as search text. Full-text search inside books (`fulltext/`) indexes in the background into local state.
- **Browsing** (`library/browse.ts`): calibre3opds's navigation (authors, series, tags, the user's categories). Books show as a grid, a list, or a view a plugin adds, such as the built-in 3D bookshelf (`plugins/bookshelf/`).
- **Reading** (`reader/`): EPUB (through epubier, a wrapper around epub.js), PDF (pdf.js), comics and text.
- **Connections** (`devices/`, `plugins/`): plugins declare connection types (and views). A reader that books are copied to, such as a CrossPoint X4 over its web API, gets a planner that compares the wanted books with what's on the device. An OPDS catalog, in calibre3opds's layout, is written to a folder or a zip.

### Sync between instances

Another instance of nexlibris is a connection, like a reader. It's stored in the library and synced, so every instance knows the others. Its chosen books and rules are the books whose files that instance keeps. How this instance reaches it (the pairing's address and key, the source of truth, where they last agreed) stays local.

Two instances of a library sync by exchanging state, not by replaying logs:

1. The instance driving the sync fetches the hub's library and its changes since their last sync.
2. It plans a merge (`common/src/merge.ts`): changes only one side made go both ways, and where both changed the same thing, the pairing's source of truth wins. The plan is shown in a preview before anything is applied.
3. Both sides apply ordinary operations.
4. They compare state hashes, and repair from the source of truth if they differ (`common/src/repair.ts`).
5. Files move by hash: the hub gets the books chosen for it, and this instance fetches the books chosen for it. Covers always go both ways, and other books' files are fetched when they're opened.

Every step can be run again, so an interrupted sync just runs again. The hub can be:

| Hub | Transport |
|---|---|
| The desktop app | HTTP on the LAN, paired by QR code or a one-time code |
| An Android phone | Bluetooth |
| A shared folder | A replica library in the folder; used for a phone over USB |

The sync API is `common/src/syncApi.ts`.

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

npm run storybook -w client        # component stories at http://localhost:6006
npm run build-storybook -w client  # static Storybook → client/storybook-static

npm run android          # debug APK (android/app/build/outputs/apk/debug)
npm run android:install  # build and install on a connected device
```

Stories sit next to their components (`client/src/**/*.stories.tsx`). Each one renders with the app's theme and a fresh in-memory sample library (`client/src/stories/sampleLibrary.ts`), so components that read or edit the library work and nothing is stored.

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
