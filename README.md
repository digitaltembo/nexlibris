# nexlibris

<p align="center">
  <img src="./icon.png" width="15%" alt="Description">
</p>

I think [Calibre](https://calibre-ebook.com/) is one of my favorite pieces of software, but what if I could make my own library management software? With a few features (an app, and more robust device management) that are not implemented in Calibre, that could play well with my new Xteink X4 Pro ereader running a fork of [CrossPoint Reader](https://github.com/crosspoint-reader/crosspoint-reader), [nexlibrOS](https://github.com/digitaltembo/nexlibrOS)

A library manager for ebooks (and hopefully eventually other media) that runs in the browser, on the desktop (Electron), on Android and on iOS. Early work in progress; see [PLAN.md](PLAN.md) for what's next.

## Architecture

One React web app runs everywhere. Each platform supplies only storage and a few native services; all library logic is shared TypeScript.

```
common/    the library model, operations, storage interface, sync      (shared by everything)
client/    React + Vite web app: UI, formats, conversion, devices, search
desktop/   Electron shell: serves client/dist, native files, LAN sync hub
android/   Kotlin WebView shell: serves client/dist, native files, Bluetooth/USB sync
ios/       Swift WKWebView shell, the same as Android's: serves client/dist, native files, Bluetooth/folder sync
server/    Node server: the web app, accounts, a library per account, sync (M4)
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
  - **Desktop, Android and iOS:** the app's native files.
    - The page calls them through the Storage, Save and Import APIs (`common/src/storageApi.ts` and its siblings), defined with [estuary-rpc](https://github.com/digitaltembo/estuary-rpc) over a message channel.
    - The desktop app serves them from its main process; the Android app from Kotlin services behind a WebView message listener; the iOS app from Swift services behind a WKWebView script message handler.
    - Stored files are read by plain `fetch` from paths the app serves (`/library/files/…`), so large files never cross the bridge.

### The client

- **Formats** (`client/src/formats/`): metadata extraction for EPUB, MOBI/AZW3, PDF, TXT/RTF and CBZ/CBR. In-browser conversion, including the CrossPoint X4/X3 optimizer, a TS port of the Calibre plugin.
- **Import** (`library/importFiles.ts`): files, folders and whole Calibre libraries. It groups formats of one book together and matches books already in the library.
- **Search** (`library/search.ts`): a Gmail-style syntax (`tag:fantasy rating:4+ -has:file`). It's the one way of choosing books: the search box, connections' catalogs and browse categories all take search text, with no separate filters. Full-text search inside books (`fulltext/`) indexes in the background into local state.
- **Browsing** (`library/browse.ts`): calibre3opds's navigation (authors, series, tags, the user's categories). Books show as a grid, a list, or a view a plugin adds, such as the built-in 3D bookshelf (`plugins/bookshelf/`) and force graph (`plugins/graph/`, books drawn together by the authors, tags and series they share).
- **Reading** (`reader/`): EPUB (through epubier, a wrapper around epub.js), PDF (pdf.js), comics and text.
- **Connections** (`devices/`, `connections/`, `plugins/`): a connection reads (lists a place's books and brings them into the library), writes (holds a catalog of books it's given), or both. OPDS servers, the static OPDS export, other instances and folders are built in; plugins add more, with formats, converters and views. A write connection's catalog is the books (or particular files) added to it by hand (Add to…, Send to…, Bulk edit) plus what its search matches; a book's details list the catalogs holding it. Syncs only add: books in the catalog are sent as stored, changed files replaced, and nothing is removed, except by the user. Before sending, books without a format the connection prefers can be converted, and files behind their book's details updated (`devices/send.ts`). A device type can add tools for what else is on the device; CrossPoint's manage its sleep images, StarDict dictionaries and fonts. Where books go on a reader or folder is a path template (`/library/<author>/<title>/`), and books move when it changes. Copies of chosen books already on the device (from Calibre, say) are kept, or moved into place, rather than sent again. A folder gets a manifest, `.nexlibris-library.json`, so another library reads its books back with their details. The static export writes an OPDS catalog in calibre3opds's layout, with its Cloudflare Pages files for search and sign-in.

### Sync between instances

Another instance of nexlibris is a connection, like a reader. It's stored in the library and synced, so every instance knows the others. Its catalog is the books that instance gets. How this instance reaches it (the pairing's address and key, the source of truth, where they last agreed) stays local.

A hub shows each instance only the books in its connection's catalog, plus the ones it already has (`common/src/scope.ts`), and serves only their files. Everything else that names a book is cut down to match: ratings, devices' records, the changes it sends. The other way round too: the driving instance sends the hub only its catalog for the hub, and offers it the rest, which the hub can ask for. Books one side lacks move only as asked (Sync from, Sync to, or chosen books); deletions never cross, and a book deleted on one side is kept off it.

Two instances of a library sync by exchanging state, not by replaying logs:

1. The instance driving the sync fetches the hub's library (as it sees it) and its changes since their last sync.
2. It plans a merge (`common/src/merge.ts`): changes only one side made go both ways, and where both changed the same thing, the pairing's source of truth wins. The plan is shown in a preview before anything is applied.
3. Both sides apply ordinary operations.
4. They compare state hashes, and repair from the source of truth if they differ (`common/src/repair.ts`).
5. Files move by hash: the hub gets the books chosen for it, and this instance fetches the books chosen for it. Covers always go both ways, and other books' files are fetched when they're opened.

Every step can be run again, so an interrupted sync just runs again. The hub can be:

| Hub | Transport |
|---|---|
| The desktop app | HTTP on the LAN, paired by QR code or a one-time code |
| An Android phone or iPhone | Bluetooth |
| A shared folder | A replica library in the folder; used for a phone over USB. Every book's details pass through it, and only the chosen books' files |

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
npm run ios              # build the web app, then the iOS app for the simulator (needs Xcode)
```

Stories sit next to their components (`client/src/**/*.stories.tsx`). Each one renders with the app's theme and a fresh in-memory sample library (`client/src/stories/sampleLibrary.ts`), so components that read or edit the library work and nothing is stored.

The Android build needs the Android SDK and JDK 17+ (e.g. `export JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home"`). Native unit tests: `cd android && ./gradlew testDebugUnitTest`.

The iOS app is `ios/nexlibris.xcodeproj` (open it in Xcode to run it on a simulator or an iPhone; set a team under Signing first), generated from `ios/project.yml` by [XcodeGen](https://github.com/yonaskolb/XcodeGen): run `xcodegen` in `ios/` after changing that, and commit the result. Its build copies `client/dist` into the app, so run `npm run build` first. Its native side is the Swift package `ios/NexlibrisKit`, which builds for macOS too, so its tests run without a simulator: `cd ios/NexlibrisKit && swift test`. With only the Command Line Tools (no Xcode), Swift Testing needs pointing at: `swift test -Xswiftc -F -Xswiftc $F -Xlinker -rpath -Xlinker $F -Xlinker -rpath -Xlinker $L`, with `F=/Library/Developer/CommandLineTools/Library/Developer/Frameworks` and `L=/Library/Developer/CommandLineTools/Library/Developer/usr/lib`.

## Server

`server/` serves the web app with accounts (M4). Signed out, a visitor gets the app as ever, with the library in their browser. Signed in, they can move the library into their account (Library folder…), where every device they sign in on opens the same one, or keep it in the browser and keep a copy in the account that it syncs with (Connections…, "Your account on …"), as with another device.

The desktop and phone apps do the same with a server at an address the user gives (Account…), for a server they run themselves. They sign in for a token, sent as a bearer token, rather than a cookie; the desktop app calls the server through its main process (`app://nexlibris/server/…`, `desktop/src/serverProxy.ts`), and the Android and iOS apps through their relay on the local network (plain http) or directly elsewhere (https only). Using the account's library, an app copies the device's library there first and keeps it, to open again.

- **API:** `common/src/serverApi.ts`, defined with estuary-rpc and served by estuary-rpc-server's `createApiServer` (`server/src/app.ts`: sessions and sync keys checked by its `authenticate` and middlewares, the web app by its static files) by its REST conventions: 200 with JSON, 204 for nothing, an error as `{ status: 'error', message }` with its status (401 signed out, 409 the library moved on). The client calls it with estuary-rpc-client over `fetch` (`common/src/rest.ts`); the sync API over HTTP uses the same conventions everywhere. Books' files stream through raw endpoints, at `api/library/files/<hash>`.
- **Accounts:** scrypt-hashed passwords; sessions in an HttpOnly, SameSite=Strict cookie, stored only as hashes; calls that change anything with the cookie must be same-origin JSON; the apps' bearer tokens are sessions too, and the API answers other origins (CORS) without credentials; sign-in attempts are rate-limited.
- **Storage:** each account's library JSON and change log in the data folder (`<data>/accounts/<id>/`), its books' files in the data folder or a bucket. Files are served only to their account, with a sandboxing CSP.

```
npm run server -- --port 8080 --data ./data                    # builds the client and server, then serves
node server/dist/main.js add-account ada                        # NEXLIBRIS_PASSWORD, else asked
node server/dist/main.js --storage s3 --bucket books --region eu-west-1
node server/dist/main.js --storage gcs --bucket books           # HMAC keys
node server/dist/main.js --storage b2 --bucket books --region us-west-004
node server/dist/main.js --storage s3 --endpoint http://localhost:9000 --path-style --bucket books   # MinIO
```

Bucket keys come only from the environment (`NEXLIBRIS_ACCESS_KEY_ID`/`NEXLIBRIS_SECRET_ACCESS_KEY`, else `AWS_*`). `--signup open|first|closed` (default: the first account only), `--tls-cert`/`--tls-key`, `--trust-proxy` behind a proxy that sets `X-Forwarded-*`; `node server/dist/main.js help` lists the rest. For development, `NEXLIBRIS_SERVER=http://localhost:8080 npm run dev` passes Vite's `/api` on to a running server.

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
