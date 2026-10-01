# nexlibris — Plan

## Vision

An application for managing libraries of content (ebooks first, then audio/video), runnable on the web, in private clouds, and on phones. Short term it's mostly Calibre; longer term it's Calibre + Plex + Jellyfin, with multiple users, encrypted data, and the ability to grant "library cards" to other people.

The near-term work is scoped so that the long shots stay possible without being built yet. See [Deferred / long shots](#deferred--long-shots).

## Guiding decisions

These are cheap to adopt now and expensive to bolt on later:

- **One frontend, many backends.** A TS/React client talks to a `LibraryBackend` interface defined in `common/`. Implementations: OPFS (in-browser, first), Node server (M4), Android (M7). Remote backends use [estuary-rpc](https://github.com/digitaltembo/estuary-rpc).
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

### M2 — In-app reading
- EPUB reader in the frontend (candidates: foliate-js, epub.js).
- Remember reading position per item (per user).

### M3 — Devices
A device is made up of two parts:
- **What it gets:** a name, a type, and which items go to it (a manual set and/or a saved filter). The device type decides the formats, e.g. X4 → `x4.epub`.
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

**`OPDSSync` (pull).** Publishes the device's selection as a static OPDS 1.2 catalog with the same shape as `~/dev/calibre3opds`, ported to TS:
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
- Optimizer settings (quality, grayscale, auto-crop, text splitting) belong to the device and count as converter inputs, so changing them marks the derived files stale. X3 is the same converter with a different profile, so supporting it is essentially free.
- Derived files are cached by `(source hash, relevant metadata, converter version)`. Editing metadata or updating the converter marks the X4 copy stale, and the next sync or catalog build regenerates it.

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

### M6 — Instance-to-instance sync
- Sync one library between two backends, e.g. browser OPFS ↔ server, and later phone ↔ server.
- Each instance tracks the last revision it has seen from each peer. Sync exchanges the operations since then, plus any file hashes the other side is missing.
- Conflict strategy: last-writer-wins per field, using timestamps plus an instance ID to break ties. Concurrent edits to the same field are rare for a personal library, so this should be enough to start.
- Operations need to be safe to apply twice, since a sync can be interrupted and retried.
- Sync goes through the `LibraryBackend` interface, so any pair of backends can sync with each other.

**Done when:** I edit metadata in the browser while offline, then sync with the server, and both sides agree. The same holds when the edit is made on the server.

### M7 — Android app
- A thin native shell around a WebView that loads the same React client.
- **Started** (`android/`): a Kotlin WebView shell serving the built client from assets at `https://appassets.androidplatform.net`. The library is stored in the app's own files, not the WebView's OPFS: the native side implements the storage API (`common/src/storageApi.ts`, defined with estuary-rpc) behind a `@JavascriptInterface`, and the client's `RpcStorage` calls it through the bridge. `StoredLibraryBackend` and all library logic stay shared TypeScript.
- Binary data crosses the bridge as base64 in 1 MiB chunks; uploads are written to a temp file and moved into place on the last chunk.
- Still to do: saving/sharing files out of the app (`<a download>` on blob URLs does nothing in a WebView), the back button closing the reader and panels, an app icon, and release signing.
- Syncs with the server, or with another instance, using M6.
- A good fit for M5: scanning an ISBN with the phone camera.
- Decided: the shared TS backend runs in the WebView; the native side only provides storage (and later filesystem/USB access).

**Done when:** the library lives on my phone, works offline, and syncs with the server.

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
