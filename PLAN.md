# nexlibris — Plan

What's next, and the decisions that shape it. How things are built is in the [README](README.md#architecture); what was done and when is in git history.

## TLDR

Status as of 2026-10-08. Milestones are listed in the order they're planned; numbers are stable names (code refers to M4 and M6), not an order.

| Milestone | Status |
|---|---|
| **Done** | M0 Foundations, M2 In-app reading, M3 Devices (CrossPoint X4/X3, OPDS catalogs written and browsed), M5 ISBN scanning. |
| **M1 Calibre-lite** | Nearly done. **Left:** prove it on the 1,123-book Calibre library, Kindle parsing, storage in a Web Worker. |
| **M6 Sync** | Works over LAN, Bluetooth and a USB folder; a phone sees only the books chosen for it, and deleting there leaves the hub's copy. **Left:** matching books on a first sync, a real phone. |
| **M7 Apps** | Android and desktop both work. **Left:** packaging and signing, native restore, a real X4. |
| **M4 Server** | Not started. |
| **M8 Background work** | Full-text search done, its work in a worker with the text stored compressed. **Left:** jobs manager, OCR, Kindle books' text. |
| **M9 Loans** | Researched, not started. |
| **M10 Reader devices** | Not started. |
| **M11 Sharing**, **M12 Audio and video** | Long shots: not before M4. |

**Next:** finish M1 and M6, then M7's packaging, then M4.

## Vision

An application for managing libraries of content (ebooks first, then audio and video) that runs on the web, in private clouds and on phones. Short term it's mostly Calibre; longer term it's Calibre + Plex + Jellyfin, with multiple users, encrypted data, and "library cards" granted to other people. Near-term work keeps those long shots reachable without building them.

## Guiding decisions

- **One frontend, many backends.** A TS/React client over the `LibraryBackend` interface in `common/`: OPFS in browsers, native files in the desktop and Android apps, a Node server in M4. Remote calls use estuary-rpc.
- **TypeScript first.** Parsing, conversion and library logic are TS that runs in the browser; Calibre tooling is a server-side fallback only.
- **Stable IDs, operations, content addressing.** UUIDs for everything; every change is a typed operation appended to a change log; files are stored by hash. Sync, devices and multi-user all build on these.
- **Per-user data keyed by user** from day one, though there's one local user.
- **Sync is predictable over clever.** Additive changes go both ways; where both sides changed the same thing, the pairing's source of truth wins, shown in a preview first. A state hash after each merge catches anything that slipped.
- **Everywhere the library goes is a connection.** Readers, catalogs and other instances of nexlibris share one model and one dialog; for an instance, its books are the ones it gets. A hub shows an instance only those, and books deleted there stay on the hub.
- **A bare top bar and one set of commands.** The bar holds the name and search; commands are one list shown as a drawer or the native menu bar.
- **Browsing as calibre3opds does,** with the user's own categories, which also become OPDS custom feeds. Other OPDS catalogs are connections too, browsed in the Library beside its own books; they're read only as the user opens them, cached for a day.
- **No DRM circumvention.** nexlibris may carry encrypted loans to a device but never holds keys or decrypts.

## Done

M0 Foundations, M2 In-app reading, M3 Devices and M5 ISBN scanning are done; their leftovers are in the milestones below. The README describes what they built.

## Milestones

### M1 — Calibre-lite
- Re-import `~/Documents/Books/Library` into the desktop app. The import stalled at the crash, with 49 Calibre books and 55 xteink files not reached. Measure memory and CPU while it imports and indexes. Look into the 25 books it skipped, mostly MOBI-only books.
- Kindle files: `@lingo-reader/mobi-parser` decodes a whole book's text into memory and fails on malformed tables of contents. Patch or replace it so those books convert and can be indexed.
- Run the OPFS backend in a Web Worker.
- Library cleanup:
  - more cleanups beside "same title and author" and "re-read metadata" (missing covers, unused files, tag spellings);
  - filling in original publication dates in bulk from Open Library, as an explicit, rate-limited action (files rarely have them);
  - a way to mark two items as not duplicates;
  - confirming "Merge all";
  - pruning thumbnails that no cover uses any more.

**Done when:** my whole Calibre library is in nexlibris, backed up, and runs smoothly.

### M6 — Sync
- **First sync, merge:** match books the two libraries both have (file hash, then ISBN, then title and a shared author) instead of keeping both copies; the source of truth's metadata wins.
- Try QR pairing and Bluetooth on a real phone.
- Find the desktop by mDNS, so an address change doesn't mean pairing again.

**Done when:** I edit on the phone offline and on the desktop meanwhile, sync, and both agree, with the preview having shown which edit won each clash. Books added on either side end up on both.

### M7 — Apps
Both apps already run on real hardware (Android on a Pixel 7a, the desktop app on macOS). What's left is making them installable and closing their gaps.
- **Android:** release signing.
- **Android:** restore natively. A restore still writes every file over the bridge (~60 s for 335 MB).
- **Desktop:** packaging (`.app` and installers), so it no longer runs from the repo.
- **Desktop:** a sync and an OPDS round trip with a real X4.

**Done when:** both apps install from a release build, and the library lives on my phone and works offline.

### M4 — Server
- Node backend in `server/` implementing `LibraryBackend` over estuary-rpc with filesystem storage. The client can point at a server or at local storage.
- Serves the sync API (M6), so browsers, phones and the desktop sync with it as they do with each other.
- **Catalogs:**
  - serves OPDS catalogs;
  - ports calibre3opds's `index.html` browser client and reader;
  - publishes catalogs to static hosts, with calibre3opds's Cloudflare search and auth files.
- **What needs a server:**
  - API keys for metadata lookups, including ISBN sources beyond Open Library;
  - optional Calibre CLI (`ebook-convert`) for formats with no TS converter;
  - reaching CrossPoint readers for `https://` clients.
- **Deployment:** Docker image, config, S3-style storage.

**Done when:** a browser and the phone each sync with the server, and it serves a catalog.

### M8 — Background work
Full-text search is done; this milestone is about running long work off the main thread and out of the way.
- **Jobs manager:** one queue for long work (indexing, conversion, OCR, device sync): resumable, with visible progress, never blocking the UI.
- **Kindle-only books in full-text search,** once M1's parser work is done.
- **OCR for scanned PDFs** with tesseract-wasm, run by the jobs manager, so their text is indexed.

**Done when:** importing and indexing a big library never makes the app stutter, and a scanned PDF is searchable.

### M9 — Loans
Library books borrowed through Libby, carried to a CrossPoint reader and taken off when due.
- **Loans on CrossPoint.** Libby EPUB loans arrive as `.acsm` tokens.
  - **Fulfillment:** preferably on the device, by CrossPoint's account plugin through `/api/plugin-jobs`, so the Adobe key never leaves the reader. Only if that can't be had, in nexlibris with a per-device key that is never synced or backed up.
  - **In the library:** a loan is an item with a `loan` record (source, dates, state), which is a schema change. Its encrypted file is never modified, converted or opened in the app.
  - **Search:** `has:loan` and `due:` in the search syntax.
  - **Device sync:** sends the EPUB and its `.epub.rights` as a pair, and removes expired or returned loans.
  - **Steps:** the plugin's fulfill action, then loan items and `.acsm` import, then device sync, then badges and reminders.
- **Searching and borrowing from Libby.**
  - **First, apply for OverDrive's official APIs.** Discovery is realistic; Circulation needs a review a personal project is unlikely to pass.
  - **Without Circulation:** link a Libby account by setup code through Libby's private API, as [odmpy](https://github.com/ping/odmpy) does, for loans, holds and fetching `.acsm` files. Then add search, borrowing and holds.
  - **Where it runs:** never from a web page; always in the desktop main process, Android's native side, or M4.

**Done when:** I borrow in Libby, drop the `.acsm` in, sync, and read on the X4; after the due date the next sync removes it. Later: I borrow from inside nexlibris.

### M10 — Reader devices
More of M3, for readers beyond CrossPoint and for changes going both ways.
- USB mass-storage readers (Kobo, Kindle) through the File System Access API and the apps' folder access.
- Two-way changes from the reader: metadata edited there, reading progress.
- Deleting a device's files from its contents list.

**Done when:** a Kobo plugged in by USB syncs as the X4 does, and reading progress comes back from either.

### M11 — Sharing (long shot)
- **Multi-user and library cards:** accounts, auth, sharing a library or part of one at a permission level. Needs M4.
- **Encryption** of metadata and files at rest, perhaps end-to-end; designed together with key sharing between users.

### M12 — Audio and video (long shot)
- `kind: 'audio' | 'video'`: playback in the app, streaming, perhaps transcoding (ffmpeg, real server resources).

## Unscheduled

Small things to pick up when they're wanted.

- **Filters:** chips typed straight into the search box; a facet sidebar with counts per tag, author and format.
- **Reading Calibre's `metadata.db`** for what a folder import misses: custom columns, read status, books with no file.

## Open questions

- Where is the source of CrossPoint's account plugin, and can it fulfill `.acsm` files? That decides whether nexlibris ever needs the device's key.
- How should an `https://`-hosted client reach CrossPoint? Through the server, HTTPS on CrossPoint, or only from `localhost`, the server and the apps.
- Where does conversion run on the server? It needs an image backend (e.g. sharp) behind a small image-ops interface, so the optimizer stays shared.
- How does estuary-rpc fit an in-process backend (OPFS in a worker)? Ideally the same transport over `postMessage`.
- Should custom metadata fields be typed (user-defined field schemas per library) for better editing?

---

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
