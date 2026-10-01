# nexlibris — Plan

## TLDR

Status as of 2026-10-01:

| Milestone | Status |
|---|---|
| **M0 Foundations** | Mostly done: schema, operations, reducer, `LibraryBackend`, tests. Lint (oxlint; typescript-eslint doesn't support TypeScript 7). Schema migrations (`common/src/migrate.ts`): libraries and logged operations are migrated on load and on restore, and a library from a newer version is refused rather than misread. Loading also replays logged changes the snapshot lacks (a crash between writing the log and the snapshot) and ignores a cut-off last log line. Missing: `server/` workspace. |
| **M1 Calibre-lite** | Nearly done: OPFS storage; drag-and-drop import of EPUB, MOBI/AZW3, PDF, TXT/RTF, CBZ/CBR, grouping a book's formats into one item; grid/list views; search; detail, bulk and custom-field editing; items with no file; ratings and reviews; delete; in-browser conversion; backup to a zip and restore (merging, non-destructive). Tried on a real 128-book, 300 MB collection: imports in ~4 s. Backups are streamed: a zip written a piece at a time (ZIP64 past 4 GB), with books stored as they are, straight to the chosen file in the apps and Chrome. **Missing:** storage in a Web Worker (it runs on the main thread). Importing another format of a book already in the library adds it to that book: matched by ISBN, else by title and an author in common, and only when the book has no file in that format (a second, different EPUB is more likely another edition). So a book added by ISBN gets its file when it's imported. |
| **M2 In-app reading** | Done: EPUB, PDF, comic and text readers, and reading position per user, stored in the library (so it's in backups and on Android). The browser's built-in PDF viewer can't report position; pdf.js can. |
| **M3 Devices** | In progress. Devices stored in the library (`library.devices`; add/edit/remove, chosen items, sync records). Plugin points: device types with formats, settings and a per-file preparation step (`client/src/devices/`). The CrossPoint plugin (`client/src/plugins/crosspoint/`) has X4/X3 types and push sync over the web API. Metadata edits reach the device because the item's metadata is written into each EPUB as it's sent; a new title or author moves the file to its new name. The X4/X3 optimizer is ported to TypeScript (`formats/convert/xteink/`): its output matches the Python's text, spine and manifest on all 128 EPUBs in the test collection. Sync makes the X4 copy for books that lack one and keeps it in the library. Tested against the CrossPoint simulator: send, optimize, remove, rename, and the reader showing edited titles and opening optimized books. `OPDSSync` is built: a device's items export as a static OPDS catalog in calibre3opds's shape (`client/src/devices/opds/`), to a zip or a folder, and sync adds the catalog's URL to the reader. The simulator's OPDS browser lists such a catalog and downloads from it. Optimizer settings (image quality, grayscale, crop, text splitting) are per device and recorded in the converter version, so changing them remakes the copies on the next sync. A device can also take a search (the search box's syntax): its matches go on the device alongside hand-picked books, and come off when they stop matching. **Missing:** catalog extras (calibre3opds's browser client, Cloudflare files), and a real X4. |
| **M4 Server** | Not started. The estuary-rpc storage API from M7 can serve as its transport. |
| **M5 ISBN scanning** | Nearly done: "Add by ISBN…" scans barcodes with the camera (the browser's `BarcodeDetector` where it reads EAN-13, otherwise zxing-cpp as WebAssembly, shipped with the app), reads a photo, or takes a typed ISBN-10/13 (`client/src/isbn/`). It looks books up on Open Library from the client (no key, CORS open): title, authors, publisher, date, pages, language, description, series (on the edition or the work), tags from subjects, and the cover; then adds them as items without a file, one by one or all at once. Books already in the library are matched by ISBN in either form. The camera needs two frames to agree before an ISBN counts, because a blurred frame can misread as another valid number. Checked on desktop (native and zxing, with a fake camera feed and a photo) and on the Android emulator (the WebView asks for camera permission; lookups work). **Missing:** a real book and phone camera; other sources (Google Books and the like, through M4's server if they need keys); attaching a file to a scanned book when the file is imported later. |
| **M6 Sync** | Not started; the change log it builds on exists. |
| **Desktop** (not a milestone) | Electron shell in `desktop/`: the same client at `app://nexlibris/`, with the library in native files (`NEXLIBRIS_LIBRARY_DIR`, default `<userData>/library`) through the same Storage and Save APIs as Android, served in the main process by `createMessageHandler`. Checked: import (an 8 MB EPUB byte-identical on disk), covers, reading, the library persisting across restarts, and plain-http LAN requests with CORS (what CrossPoint sync needs, unlike the https web build). Has the app icon (window and dock). Missing: packaging (`.app`/installers) and a CrossPoint sync tried from it. |
| **M7 Android** | Runs on an emulator (API 37): import through the system picker (including a 3.4 MB file, byte-identical on disk), reading, and the library persisting across restarts and reinstalls. Back closes the reader, dialogs and panels before leaving the app. Backups and book files save out through the system "Save as" picker. Import has a native path: the app copies and hashes picked files into the library itself, so the 300 MB test collection imports in ~12 s (it took ~3 min); its 335 MB backup saves in ~21 s and restores in ~60 s. Its biggest book opens in ~10 s. Has the app icon (adaptive, with a themed-icon layer). Missing: release signing, a real phone; restore could take the native path too. |

**Next:** M3's and M5's code is in place; what's left is trying them on real hardware: an X4, and scanning real books with a phone (the desktop app can reach it over plain http). Filters are done (see Backlog), and devices now pick books by the same rules. Then M4 (server), which can also serve the catalog. The real-collection leftovers are done: a native import path (Android and desktop) and a streamed backup. Smaller still: restoring natively on Android, and storage in a Web Worker.

**Backlog** (not yet scheduled; see [Backlog](#backlog)): CrossPoint/X4 plugin, full-text search, OCR for scanned PDFs via a background jobs manager, Libby search and borrowing. (Filters, from the backlog, are done.)

## Vision

An application for managing libraries of content (ebooks first, then audio/video), runnable on the web, in private clouds, and on phones. Short term it's mostly Calibre; longer term it's Calibre + Plex + Jellyfin, with multiple users, encrypted data, and the ability to grant "library cards" to other people.

The near-term work is scoped so that the long shots stay possible without being built yet. See [Deferred / long shots](#deferred--long-shots).

## Guiding decisions

These are cheap to adopt now and expensive to bolt on later:

- **One frontend, many backends.** A TS/React client talks to a `LibraryBackend` interface defined in `common/`. Implementations: OPFS (in-browser, first), Node server (M4), Android (M7), and desktop (Electron, native files through the same storage API as Android). Remote backends use [estuary-rpc](https://github.com/digitaltembo/estuary-rpc).
- **Prefer TS implementations** of library functionality (metadata extraction, conversion). Calling out to Calibre tooling is a fallback, server-side only.
- **Stable IDs everywhere.** Items, files, devices, and users get UUIDs, never array indices or paths. This is what makes sync, devices, and multi-user possible later.
- **Changes as operations.** The library is mutated through typed operations (`addItem`, `updateMetadata`, `attachFile`, …) that are appended to a change log with a monotonically increasing revision. Device sync and instance-to-instance sync are both built on it.
- **Content-addressed files.** Media files are stored by hash. Metadata references hashes, so dedupe, integrity checks, and "has this changed since last sync?" all come for free.
- **Per-user data is keyed by user from day one.** Ratings and reviews live under a user ID even while there's only one implicit local user.

## Data model (sketch)

The metadata for one library is a single JSON document, validated by a schema in `common/` (e.g. zod), with a `schemaVersion` for migrations. Media files are stored separately.

```ts
interface Library {
  schemaVersion: number;
  id: string;
  name: string;
  revision: number;                 // bumped on every applied operation
  items: Record<ItemId, Item>;
  devices: Record<DeviceId, Device>;
  userData: Record<UserId, { ratings: Record<ItemId, number>; reviews: Record<ItemId, Review> }>;
}

interface Item {
  id: ItemId;
  kind: 'book' | 'audio' | 'video';      // only 'book' in early milestones
  title: string;
  creators: { name: string; role: string }[];
  identifiers: Record<string, string>;   // isbn, openlibrary, goodreads, …
  tags: string[];                        // free-form labels; changed via addTags/removeTags so they merge on sync
  metadata: Record<string, unknown>;     // arbitrary, namespaced keys (e.g. "series", "x4:fontSize")
  files: FileRef[];                      // may be empty: you can catalog books you don't own a file for
  addedAt: string; updatedAt: string;
}

interface FileRef {
  hash: string;                          // content address
  format: string;                        // 'epub', 'x4.epub', 'mp3', …
  size: number;
  derivedFrom?: { hash: string; converter: string; converterVersion: string };
}
```

Open question: a single blob is fine for thousands of items. If it gets slow, the operation-based API means storage can be sharded without changing the client.

## Milestones

### M0 — Foundations
- Workspace setup for `client/`, `common/`, `server/` (TS, shared tsconfig, lint, test runner).
- `common/`: library schema + validation, operation types, a pure `applyOperation(library, op)` reducer, and the `LibraryBackend` interface.
- Unit tests for the reducer and schema migrations.

**Done when:** a library can be created and mutated in tests via operations, round-tripping through JSON.

### M1 — Calibre-lite in the browser (OPFS backend)
- OPFS backend running in a Web Worker: stores the library JSON and content-addressed files.
- Import EPUBs: drag-and-drop, extract title/author/identifiers/cover from the OPF.
- Library view (grid/list), search and filter, item detail page.
- Edit metadata, including arbitrary custom fields.
- Add items with no file attached (wishlist/physical books).
- Ratings and reviews.
- Export/import the whole library (JSON + files as a zip) as a backup and the first form of portability.

**Done when:** I can manage my real ebook collection entirely in the browser and back it up.

**Tried on a real collection** (2026-10-01): a Calibre export of 128 public-domain books as 322 files (EPUB, MOBI and CrossPoint `x4.epub`; 300 MB). In Chrome it imports in about 4 s as 128 items, each with all its formats and a cover, and backs up in 2.6 s / restores in 1.8 s. What it led to:
- Import groups files that differ only in format (`dune.epub`, `dune.mobi`, `dune.x4.epub`) into one item, taking metadata from the best format and the cover from any that has one, and doesn't convert a MOBI to EPUB when the book came with an EPUB. It saves every 20 items and shows progress.
- XML declarations in single quotes, as Calibre writes them, are accepted everywhere (happy-dom rejected them, which hid a third of the collection from tests run under Node).
- Search matches the starts of words, ignoring case and accents ("verne" no longer finds "governess").
- Since then (2026-10-01): backups are streamed (`library/zip.ts`, `saveParts`), so they're never held in memory, and importing another format of a book that's already in the library adds it to that book.

### M2 — In-app reading
- EPUB reader in the frontend (candidates: foliate-js, epub.js).
- Remember reading position per item (per user). **Done:** `userData.positions` holds `{hash, locator, progress}` set by a `setPosition` operation, debounced so page turns don't flood the change log. Each viewer defines its locator: an EPUB CFI (via epubier's `position`/`onLocationChange`), a comic page index, a pdf.js page number, or a text scroll fraction.

### M3 — Devices

> CrossPoint/X4 support is to be built as a plugin (see [Backlog](#backlog)); the core part of M3 is the plugin points it needs.

A device is made up of two parts:
- **What it gets:** a name, a type, and which items go to it (a manual set and/or a saved filter). (Built: `Device.query`, a search in the search box's syntax, resolved by `devices/selection.ts` for sync and the catalog.) The device type decides the formats, e.g. X4 → `x4.epub`.
- **How it gets them:** a sync target. Each target is a class implementing a common `DeviceSync` interface, roughly `plan(desired, current) → actions` and `apply(actions)`. Two targets to start with:

**`CrossPointSync` (push).** Writes directly to an X4 running CrossPoint in File Transfer mode, using its web server (see `crosspoint-reader/docs/webserver-endpoints.md`):
- `GET /api/status` to identify the device (`device: "X4"`, `hardwareMac` as a stable ID).
- `GET /api/files?path=…` to list what's on the device (names and sizes).
- `POST /upload?path=…` to send files; it overwrites existing files and clears CrossPoint's EPUB cache for them. The WebSocket upload on port 81 is faster and can be added later.
- `POST /delete` to remove books that are no longer selected. `/mkdir` and `/move` handle folder layout.
- Address: `crosspoint.local`, falling back to an IP the user enters. CrossPoint's UDP discovery isn't usable from a browser.
- **Sync state is kept in the library** (the device record stores the path, hash, and size of each file it placed). It's checked against `/api/files` before each sync. The device can't hold a `.nexlibris/` manifest, because CrossPoint refuses to create, download, or rename anything whose name starts with `.`. If an on-device marker is wanted, it has to use a plain name such as `/nexlibris/manifest.json`.
- Only files nexlibris placed are ever deleted. Anything else on the SD card is left alone.
- **Reachability caveat:** CrossPoint serves plain `http://` on the LAN. It does send CORS headers, but a client served over `https://` is blocked as mixed content (Chrome's private-network rules may add more restrictions). In M3 that means running the client from `localhost`. After that, the sync can be done by the server (M4) or the Android app (M7).

**Built so far** (CrossPoint push):
- `Device` in `common/src/types.ts` holds the name, type, settings (address, folder), the chosen items and `placed`: what each sync put where (`itemId`, source `hash`, `size` as sent, and a preparation `key`). Operations: `addDevice`, `updateDevice`, `removeDevice`, `addDeviceItems`, `removeDeviceItems`, `recordDeviceSync`.
- `client/src/devices/`: plugin types (`DeviceType`, `DeviceTarget`, `Preparation`), `planSync` (pure: desired vs. placed vs. listed) and `runSync`. Files go to `<folder>/<Title> - <Author>.<ext>`. A file whose size changed on the device is treated as the user's and let go; a file nexlibris didn't place is never overwritten. Uploads run before removals, so a renamed book's old copy is only deleted once the new one has arrived.
- `embedMetadata` writes the item's metadata into EPUBs as they're sent (`formats/epubMetadata.ts`), keyed by a fingerprint of that metadata, so editing metadata re-sends the book.
- UI: Devices… dialog (add/edit, sync with a preview), and a Devices section in the bulk editor to add or remove the selection.
- The optimizer (`client/src/formats/convert/xteink/`) is a TS port of `optimizer.py` + `textsplit.py`, with the image half done on canvas as the device web UI does. It's the `xteink-x4`/`xteink-x3` converters (EPUB → `x4.epub`/`x3.epub`). A CrossPoint device type `makes` its format: syncing a book with only an EPUB converts it, attaches the result as a derived file, and sends that; later syncs reuse it. A derived copy from an older converter version, or from a source no longer on the item, is stale: it's remade and the old one detached. Metadata isn't part of the cache key, since it's written in when sending.
  - Checked against the Python on the 128-EPUB test collection: identical visible text per file (17,762 files), spine and manifest. Images: Alice (89 illustrations) optimizes in ~3 s in Chrome vs 1.3 s in Python, at a similar size.
  - Encoding uses `toDataURL`: Chrome defers async canvas encoding in background tabs to ~1/s, which made a 90-image book take 90 s.
  - It differs from the Python in two small ways: JPEG media types are fixed for renamed images (the Python's lxml path missed them), and an image that can't be decoded keeps the renamed `.jpg` path its references now use.
- The CrossPoint simulator (`crosspoint-reader/.pio/build/simulator_x4_pro/program`) serves the same API on `127.0.0.1:8080`. It runs headless with `SDL_VIDEODRIVER=dummy`, `CROSSPOINT_SIM_INPUT_SCRIPT='2000:DOWN;2400:DOWN;2800:ENTER;4000:DOWN;4400:DOWN;4800:ENTER'` (File Transfer → Create Hotspot) and `./fs_/` as its SD card. Its `/delete` refused the `paths` list form, so files are deleted one at a time.

**`OPDSSync` (pull).** Publishes the device's selection as a static OPDS 1.2 catalog with the same shape as `~/dev/calibre3opds`, ported to TS.

Built (`client/src/devices/opds/`):
- `buildCatalog` (pure) writes calibre3opds's feeds: `index.xml` (recent books), `navigation/` (titles, recent, authors, series, tags; 25 per page), a search feed per title/author/tag/series term with `searchDescription.xml`, and the `books/`/`covers/` files to copy. Book stems, slugs and the `relation` tag links match calibre3opds, so its web client reads the output. Entry ids are `urn:uuid:<item id>`.
- `exportCatalog` offers every format of each item that the device type takes. It makes a missing X4 copy as sync does and attaches it to the item, and writes current metadata into each EPUB through the type's `prepare`.
- Two destinations (`sinks.ts`): a zip saved with `saveFile`, or a folder picked with the File System Access API (Chrome/Edge). A folder keeps `nexlibris-catalog.json`, so re-exporting copies only changed books and removes stale feeds and files.
- The CrossPoint types have a "Catalog URL" setting; sync lists the reader's OPDS servers (`GET /api/opds`) and adds the catalog if it's missing (`POST /api/opds`). The simulator's own web server lacks `/api/opds`, so that call is tested against a fake. The simulator's OPDS browser, given the catalog in `/.crosspoint/opds.json`, listed and downloaded the books (File Transfer → Cloud Libraries).
- Not ported yet: calibre3opds's `index.html` browser client and reader, custom feeds, and the Cloudflare search/auth files.

Original plan:
- Output: `index.xml`, navigation feeds (titles, recent, authors, tags), `books/<id>.<format>`, `covers/`, precomputed search feeds, and the optional `index.html` browser client.
- Acquisition links include the `x4.epub` copy. CrossPoint's OPDS browser already ranks `.x4.epub` links above plain `.epub`, so the reader picks the optimized file without extra work.
- Output can go to an OPFS directory to download as a zip, to a local folder via the File System Access API, or (after M4) be served directly by the server. Deployment to static hosts (Cloudflare Pages + Basic Auth, as in calibre3opds) comes later.
- Can register itself on a CrossPoint device via `POST /api/opds`, which ties the two targets together.
- Pull means there's no per-device sync state. The catalog is just regenerated whenever the selection or metadata changes.

**X4 device type:**
- Converts selected books to `x4.epub`, porting the CrossPoint optimizer from `~/dev/crosspoint/calibre-plugins` (`crosspoint_reader/optimizer.py` + `textsplit.py`, ~1.2k lines of Python; the `x4.epub`/`x3.epub` output formats in that repo use it). Its steps are:
  - **Images:** scale to fit the screen (X4 480×800, X3 528×792), convert to grayscale, and re-encode as JPEG (quality 85 by default), with optional auto-crop of uniform margins. Base64 `data:` images are extracted into real files.
  - **Container fixes:** rename rasters to `.jpg`; strip stale `<img>` dimensions; unwrap SVG-wrapped covers; fix OPF media types and cover meta; sync the NCX identifier; inject a small defensive stylesheet; re-zip with `mimetype` first.
  - **Text splitting**, for the firmware's memory limits: paragraphs over ~1.6 KB are split into ~1.2 KB at sentence boundaries; spine files over ~9.5 KB are split into ~7 KB chunks, with the manifest/spine and `#fragment` links remapped. Embedded fonts and page-list navs are dropped. Each transform checks that the visible text is unchanged and reverts itself if not.
  - On any failure, fall back to the original EPUB rather than blocking the sync.
- The CrossPoint web UI (`crosspoint-reader/src/network/html/FilesPage.html`) has a browser-native version of the image half (JSZip + canvas, including auto-crop and split previews). It's a closer starting point for the TS image pipeline, while the Python is the reference for text splitting and container fixes.
- Optimizer settings (quality, grayscale, auto-crop, text splitting) belong to the device and count as converter inputs, so changing them marks the derived files stale. (Built: `DeviceType.makes(device)` returns a converter whose version carries the non-default options, e.g. `1+q60+color`; defaults keep the plain `1`. An item holds one copy per format, so two devices with different settings would remake each other's copy on every sync; per-device copies can wait until someone has two.) X3 is the same converter with a different profile, so supporting it is essentially free.
- Derived files are cached by `(source hash, converter version)`; updating the converter marks the X4 copy stale, and the next sync regenerates it. Metadata isn't part of the key: it's written into the copy as it's sent, so editing it doesn't redo the image work. (Built: see "Built so far" above.)

**Done when:** I pick books for my X4, put it in File Transfer mode, press sync, and it ends up correct, including after I edit metadata. The same selection is also browsable from the X4 as an OPDS catalog.

### M4 — Server backend
- Node backend in `server/` implementing `LibraryBackend` over estuary-rpc, with filesystem storage.
- Client can point at either OPFS or a server.
- Optional Calibre CLI integration (e.g. `ebook-convert`) for formats without a TS implementation.
- Host for any API keys needed by metadata lookups.

### M5 — ISBN scanning and lookup
- Barcode scanning from the camera (`BarcodeDetector` where supported, a zxing-based fallback otherwise).
- Lookup via Open Library (no API key required, so this may work client-side even before M4); Google Books or others via the server if they need keys.
- Creates an item, with or without a file.

Notes from building it:
- Lives in `client/src/isbn/` (`isbn.ts` checking and converting ISBNs, `openLibrary.ts` the lookup, `scanner.ts` the decoders) and `components/IsbnDialog.tsx`.
- Lookup takes up to four requests: `/api/books?jscmd=data` for the edition, then the edition, work and series records for language, description and series. Only the first is needed; the rest are best effort.
- zxing-wasm's wasm (~1 MB, ~420 kB gzipped) is a Vite asset loaded on first use, never from its default CDN, so scanning works offline and in the apps.
- Scanned books are added without a file. Importing the book's file later makes a second item; attaching a file to an existing item (the M1 leftover) would fix both.
- Testing without a camera: Electron/Chromium take `--use-fake-ui-for-media-stream --use-fake-device-for-media-stream --use-file-for-fake-video-capture=<file.y4m>`; zxing-wasm's writer can make the barcodes.

### M6 — Instance-to-instance sync
- Sync one library between two backends, e.g. browser OPFS ↔ server, and later phone ↔ server.
- Each instance tracks the last revision it has seen from each peer. Sync exchanges the operations since then, plus any file hashes the other side is missing.
- Conflict strategy: last-writer-wins per field, using timestamps plus an instance ID to break ties. Concurrent edits to the same field are rare for a personal library, so this should be enough to start.
- Operations need to be safe to apply twice, since a sync can be interrupted and retried.
- Sync goes through the `LibraryBackend` interface, so any pair of backends can sync with each other.

**Done when:** I edit metadata in the browser while offline, then sync with the server, and both sides agree. The same holds when the edit is made on the server.

### M7 — Android app
- A thin native shell around a WebView that loads the same React client.
- **Started** (`android/`): a Kotlin WebView shell serving the built client from assets at `https://appassets.androidplatform.net`. The library is stored in the app's own files, not the WebView's OPFS: the native side implements the storage API (`common/src/storageApi.ts`, defined with estuary-rpc) behind a bridge object (`WebViewCompat.addWebMessageListener`, which WebView only gives to the app's own origin), and the client's `RpcStorage` calls it through the bridge. `StoredLibraryBackend` and all library logic stay shared TypeScript.
- **Saving out:** WebView ignores `<a download>`, so a second API (`common/src/saveApi.ts`) uploads the file in chunks to the app's cache, then opens the system "Save as" picker (`ACTION_CREATE_DOCUMENT`) and copies it there. The client's `saveFile` uses this in the app and a normal download in a browser.
- Binary data is written over the bridge as base64 in 1 MiB chunks (native `Uint8Array.toBase64` where the WebView has it); uploads go to a temp file and are moved into place on the last chunk. Stored files are *read* without the bridge: the app serves `files/` at `/library/files/…` from its asset loader, and `AndroidStorage` fetches them.
- **Performance on the emulator** (2026-10-01, the 300 MB collection from M1): importing all 322 files takes about 3 minutes (Chrome: 4 s). Most of that is reading the picked files through Android's document provider (~3 MB/s) and writing them over the bridge. Fixed with a native import path (`common/src/importApi.ts`): the app copies and hashes picked files into the library's stored files itself, and the web app reads them from `/library/files/…`. Now ~3 s to copy and ~9 s to import. Restoring the collection's 335 MB backup takes ~60 s, as restore still writes each file over the bridge. Opening a 24 MB EPUB with 117 images takes about 10 s (it took 42 s: the emulator's WebView spends ~200 ms per blob URL, so epubier now uses data URLs on all platforms).
- Back is handled in the web app: each open overlay (reader, panel, dialog, selection) adds a history entry, so Back closes it, in the browser as well as in the app.
- Still to do: release signing, and trying it on a real phone (the emulator may be slower than one).
- Syncs with the server, or with another instance, using M6.
- A good fit for M5: scanning an ISBN with the phone camera.
- Decided: the shared TS backend runs in the WebView; the native side only provides storage (and later filesystem/USB access).

**Done when:** the library lives on my phone, works offline, and syncs with the server.

## Backlog

Agreed work that isn't scheduled into a milestone yet.

- **CrossPoint/X4 as a plugin.** Support for CrossPoint readers (X4, X3) lives in a plugin rather than the core. The plugin owns everything specific to the device: the device type and its management (address, status, what's on it, sync targets), and the `x4.epub`/`x3.epub` optimized formats and their converter. This reshapes M3: the core provides the plugin points (device types, sync targets, formats/converters, device-management UI), and CrossPoint is the first plugin built on them.
- **Full-text search.** Index the text of every item so it's searchable. The search UI must make clear whether you're searching for items (title, author, metadata) or within the text of books, e.g. separate modes or clearly separated results, never one undifferentiated list.
- **OCR for scanned PDFs.** PDFs without a text layer are run through [tesseract-wasm](https://github.com/robertknight/tesseract-wasm) so their text can be indexed. OCR is slow, so it runs in a background jobs manager: queued, resumable, with visible progress, and not blocking the UI. Other long tasks (conversion, indexing, device sync) should use the same manager.
- **Libby.** Search Libby and borrow from it. The approach is still open: first look at how commonstacks and bytebooks integrate with Libby/OverDrive, and what they rely on (official APIs, the Libby web client's endpoints, or account linking).
- **Filters.** Alongside the search box, a filter option opened in a modal: build filters such as author, tag, rating (and other fields), which narrow the library view and combine with search. Active filters stay visible (e.g. as chips) and are easy to clear.
  - **Done.** "Filters…" opens a rule builder in the style of smart playlists: rows of field, condition and value ("Tags include Fantasy or Sci-fi", "Rating is at least 4", "Added in the last 30 days", "Has no file"), matching all or any. Rules show as chips under the toolbar, each removable, and combine with the search box. Clicking a tag in an item's details filters by that tag exactly. A device's "books by rules" uses the same builder.
  - Rules are stored and evaluated as search text, a Gmail-style syntax (`tag:"Science fiction",Fantasy rating:4+ -has:file added:"last 30 days"`, `or` between terms), so a device keeps its rules as its `query` string and older word searches still work. `library/search.ts` parses and matches it; `library/filters.ts` converts between rules and text and words the chips. Text the rules can't show (a phrase, `or` mixed with "and") is edited as text.
  - Not done: autocomplete chips typed straight into the search box, and a facet sidebar (counts per tag, author, format). Both could reuse the same engine.

## Deferred / long shots

Don't build these yet. The guiding decisions above are what keep them reachable.

- **Multi-user and library cards.** Accounts, auth, sharing a library or a subset of it with other users at a permission level. Needs the server backend.
- **Encryption.** Encrypted library metadata and files at rest, possibly end-to-end so a hosted server can't read the library. This interacts heavily with multi-user key sharing, so design the two together.
- **Audio and video (the Plex/Jellyfin side).** `kind: 'audio' | 'video'`, in-app playback, streaming, and possibly transcoding (which pulls in ffmpeg and real server resources).
- **Private cloud deployment.** Docker image, config, storage backends such as S3.
- **More device types and sync targets** beyond CrossPoint and OPDS: a `FileSystemSync` for USB mass-storage readers (Kobo, Kindle) via the File System Access API, phones, and pushing OPDS catalogs to static hosts.
- **Calibre library import**, by reading an existing Calibre `metadata.db`. Arguably high value for migration, so it could be pulled forward.

## Open questions

- How should CrossPoint be reached from an `https://`-hosted client? Options: always go through the server, add HTTPS to CrossPoint, or accept that this only works from `localhost`, the server, or Android.
- Where does conversion run? In the browser it's `OffscreenCanvas` in a worker. The Node server needs a different image backend (e.g. sharp). Hide that behind a small image-ops interface so the optimizer itself stays shared.
- How does estuary-rpc fit an in-process backend (OPFS in a worker)? Ideally the same transport over `postMessage`, so the OPFS backend exercises the real RPC path.
- How should custom metadata fields be typed for nice editing UI? Free-form `unknown`, or user-defined field schemas per library?

---

## Original notes

<details>
<summary>The brain-dump this plan was derived from</summary>

My ambition here is probably too grand, but broadly I would like the following qualities:
* an application for managing libraries of content, runnable on the internet, in private clouds, on phones
* in the long term supporting multiple users, encrypted data etc, doing things like managing a private library and granting library cards to other users
* in the shorter term, combining qualities of plex, jelyfin, and calibre
* and maybe mostly calibre for the shortest term, managing ebooks
* items in the library can come with fairly arbitrary metadata, although stored in a predictable format
* the metadata for a single library can hopefully be stored in a single JSON blob
* include the ability to give ratings, reviews
* include the ability to add items for which you either do or do not have the underlying media file
* include the ability to set up _devices_
* devices get a persistent set of the library, so the next time they are connected, they can be synced with any changes since last they synced
* devices can get some additional management specific to the device type
* example workflows:
  * I configure my library, and then configure the set of books which go to my xteink x4 ereader
    * books going to an xteink x4 ereaders are automatically converted into their optimized x4.epub format
    * when e.g. metadata on a book is updated, the x4.epub file is automatically updated
    * the next time I plug my ereader in, I can press a single button, and it will ensure all of the appropriate files are in the appropriate places
  * ability to scan ISBN barcodes and look up and add a book automatically (probably would need a real backend for this to encode tha ppropriate API keys)
* a TS/react frontend which can be used against a few different backends, including a pseudo-backend that stores and manages via OPFS
  * as much as possible I would like to view the media from within the frontend (e.g. epubs, mp3s, movies)
  * use https://github.com/digitaltembo/estuary-rpc to communicate with backends
* an https://github.com/digitaltembo/estuary-rpc backend, which might call out to calibre tooling, but prefer to have TS implementations of functionality where possible
* An android app which poses as a simple webview and then is effectively one of the backends, so communication is done with the android device itself instead of a server
  * the API should include syncing between different instances as well, so e.g. the android app could be synced with a website

</details>
