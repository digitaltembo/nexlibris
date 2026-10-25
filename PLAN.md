# nexlibris — Plan

What's next, and the decisions that shape it. How things are built is in the [README](README.md#architecture); what was done and when is in git history.

## TLDR

Status as of 2026-10-21. Milestones are listed in the order they're planned; numbers are stable names (code refers to M4 and M6), not an order.

| Milestone | Status |
|---|---|
| **Done** | M0 Foundations, M2 In-app reading, M3 Devices (CrossPoint X4/X3, OPDS catalogs written and browsed), M5 ISBN scanning. |
| **M1 Calibre-lite** | Nearly done. **Left:** prove it on the 1,123-book Calibre library, Kindle parsing, storage in a Web Worker. |
| **M6 Sync** | Works over LAN, Bluetooth and a USB folder; a phone sees only the books chosen for it, and deleting there leaves the hub's copy. **Left:** matching books on a first sync, a real phone. |
| **M13 Connections** | Built: connections that read, write or both, each writer with a catalog (Add to…, Send to…, search); additive syncs; files behind their details; OPDS, static export (Cloudflare), instances and folders built in; CrossPoint a plugin with the X4/X3 formats. **Left:** folders in the apps, browsing connections by author/series, exposure on the folder hub and server, checking it by hand. |
| **M7 Apps** | Android and desktop both work; an iOS app, the same shell as Android's, is written and its native side tested on macOS. Releases are built and published from a GitHub release (`.github/workflows/release.yml`, RELEASING.md). **Left:** running iOS on a device, a first release (an Android keystore; an Apple account for TestFlight and a signed macOS app), native restore, a real X4. |
| **M4 Server** | Started: accounts, a library per account (books' files on disk or in S3, GCS or B2), moving a browser's library there and back, or syncing with it; the desktop and phone apps sign in to a server at an address the user gives, and open the account's library or sync with it; OPDS feeds served live, as OPDS 1.2 XML or 2.0 JSON. a Docker image. Releases publish the image (ghcr.io) and the server on npm. **Left:** scoping, the calibre3opds web client. |
| **M8 Background work** | Full-text search done, its work in a worker with the text stored compressed. **Left:** jobs manager, OCR, Kindle books' text. |
| **M9 Loans** | Researched, not started. |
| **M10 Reader devices** | Not started. |
| **M11 Sharing**, **M12 Other media** | Long shots: not before M4. M12 planned: audiobooks, music, video and images, after large-file groundwork. |

**Next:** check M13 by hand and finish M1 and M6, then M7's first release, then the rest of M4.

## Vision

An application for managing libraries of content (ebooks first, then audiobooks, music, video and images) that runs on the web, in private clouds and on phones. Short term it's mostly Calibre; longer term it's Calibre + Plex + Jellyfin, with multiple users, encrypted data, and "library cards" granted to other people. Near-term work keeps those long shots reachable without building them.

## Guiding decisions

- **One frontend, many backends.** A TS/React client over the `LibraryBackend` interface in `common/`: OPFS in browsers, native files in the desktop, Android and iOS apps, a Node server in M4. Remote calls use estuary-rpc.
- **TypeScript first.** Parsing, conversion and library logic are TS that runs in the browser; Calibre tooling is a server-side fallback only.
- **Stable IDs, operations, content addressing.** UUIDs for everything; every change is a typed operation appended to a change log; files are stored by hash. Sync, devices and multi-user all build on these.
- **Per-user data keyed by user** from day one, though there's one local user.
- **Sync is predictable over clever.** Additive changes go both ways; where both sides changed the same thing, the pairing's source of truth wins, shown in a preview first. A state hash after each merge catches anything that slipped.
- **Everywhere the library goes is a connection,** and a connection reads (lists a place's books and downloads them), writes (takes books), or both. Readers, catalogs, folders and other instances of nexlibris share one model and one dialog; what a connection writes, and what an instance exposes to a peer, is its catalog: books added by hand, and those its search adds.
- **Sending only copies.** Sending or syncing to a connection sends files the library already has; it never converts or rewrites them. A connection that prefers formats the books lack asks first: convert (into the library, once) or send anyway. Syncs only add; deleting is always the user's own act.
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

### M13 — Connections
Built: connections by what they do (read, write, or both: `devices/types.ts`), each write connection holding a catalog (books or particular files, plus what its search adds) managed by Add to…, Send to…, a book's details and Bulk edit; strictly additive syncs; files sent as stored, marked behind their book's details, with one send flow asking to convert to preferred formats and update files; OPDS server, static export (formats, Cloudflare search routing and Basic Auth), instance and folder built in (`connections/`); CrossPoint one reader type with a model, adding the X4/X3 formats and converter; instances exposing only their catalog for a peer (files too, `allows`), with Sync from, Sync to, single books, and offers to a hub; read connections browsed in the Library. Left:
- **Folders in the apps:** the folder connection uses `showDirectoryPicker`, so Chrome, Edge or the desktop app's Chromium. Android needs it over `DocumentTreeStorage`, and the desktop app would do better with a folder storage in the main process (no permission prompts).
- **Browsing by organization:** a reader's, folder's or instance's books show flat in the Library (`['connection', id]`), and OPDS servers keep `['source', …]`. Give read connections levels (authors, series, tags) and fold `source` into `connection`.
- **Exposure everywhere:** the folder hub and the server don't scope what a peer sees by its connection's catalog yet (the server allows every file).
- **Instance browsing at scale:** "On it…" reads the peer's whole view through `state`; a paged, searchable `browse` endpoint if libraries get large.
- Verify the Done-when by hand, on a real X4, Cloudflare Pages and a phone.

**Done when:** I browse Gutenberg and download a book; send a book that has only an EPUB to the X4 and am asked to convert it; edit a book's title and see its files marked behind, then updated and replaced on the next sync; export a catalog of `tag:"xteink"` books as `x4.epub`s whose search works on Cloudflare Pages; back the library up to a USB drive and read it back in another instance; and from the desktop, browse only the phone's books its connection exposes, and download one.

### M7 — Apps
Android and desktop already run on real hardware (Android on a Pixel 7a, the desktop app on macOS). What's left is making them installable and closing their gaps.
- **iOS:** build and run it in Xcode (it was written without one: its native side, `ios/NexlibrisKit`, builds and passes its tests on macOS, and the UIKit shell typechecks against Mac Catalyst), then on an iPhone: storage, import, saving, the library and sync folders (iCloud Drive too), sync over the network and hosting it over Bluetooth, ISBN scanning, a CrossPoint reader.
- **iOS:** an Apple developer account, then TestFlight (the release workflow archives and uploads once its secrets are set, RELEASING.md); Bluetooth hosting in the background (`bluetooth-peripheral`), which iOS stops when the app isn't open.
- **Android:** a release keystore, kept safe and given to the release workflow (signing is set up; without it the APK is unsigned).
- **Android:** restore natively. A restore still writes every file over the bridge (~60 s for 335 MB).
- **Desktop:** a first release of the Tauri app's installers (built by the release workflow for macOS, Windows and Linux) checked on each; a Developer ID for macOS, as it's only signed ad hoc without one, and perhaps Windows code signing.
- **Android:** a sync with a real X4 (its calls to the reader now go through the app, as the page can't call plain http).
- **Desktop:** a sync and an OPDS round trip with a real X4.

**Done when:** both apps install from a release build, and the library lives on my phone and works offline.

### M4 — Server
Built: `server/` serves the web app, accounts (sign-in by a session cookie; sign-up open, first account only, or closed), the library per account over estuary-rpc-server (books' files on disk or in an S3-style bucket: AWS, GCS, Backblaze B2, MinIO, R2), and the sync API per account. Signed out, the page works as before; signed in, the library moves to the account and back (Library folder), or stays and syncs with it (Connections). The desktop and Android apps choose a server by its address (self-hosting) and sign in for a bearer token; they open the account's library instead of the device's (copied there first, the device's kept), or sync with it.
- **Left in the sync:** scoping what each device sees, as the other hubs do; listing and forgetting an account's paired devices; carrying a browser's pairings when its library moves.
- **Accounts:** a hidden password prompt in the CLI; Android servers under a path (its sync relay, `PeerService.kt`, calls origins only); the apps' token kept in local storage, rather than the system's keychain; resetting a password from the web; deleting an account and its files.
- **Catalogs:** "OPDS feed on your server" connections are served live at `/opds/` (OPDS 1.2 or 2.0, readers signing in with HTTP Basic). Left:
  - ports calibre3opds's `index.html` browser client and reader;
  - the desktop app serving feeds on the LAN the same way (common's `serveOpds`, beside the sync host).
- **What needs a server:**
  - API keys for metadata lookups, including ISBN sources beyond Open Library;
  - optional Calibre CLI (`ebook-convert`) for formats with no TS converter;
  - reaching CrossPoint readers for `https://` browser clients (the Android app relays its own calls).

**Done when:** a browser and the phone each sync with the server, and it serves a catalog.

### M8 — Background work
Full-text search is done; this milestone is about running long work off the main thread and out of the way.
- **Jobs manager:** one queue for long work (indexing, conversion, OCR, device sync): resumable, with visible progress, never blocking the UI.
- **Kindle-only books in full-text search,** once M1's parser work is done.
- **OCR for scanned PDFs** with tesseract-wasm, run by the jobs manager, so their text is indexed and PDF to EPUB (`pdfText/`, which reads only text layers now) can convert them.

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
- USB mass-storage readers (Kobo, Kindle), as M13's folder connection with their own templates and formats.
- Two-way changes from the reader: metadata edited there, reading progress.
- Deleting a device's files from its contents list.

**Done when:** a Kobo plugged in by USB syncs as the X4 does, and reading progress comes back from either.

### M11 — Sharing (long shot)
- **Multi-user and library cards:** accounts, auth, sharing a library or part of one at a permission level. Needs M4.
- **Encryption** of metadata and files at rest, perhaps end-to-end; designed together with key sharing between users.

### M12 — Other media (long shot)
Audiobooks, music, video and images, in that order, as items beside books. Content addressing, operations, merge, sync, scoping, connections, search and browsing already ignore what a file holds; `Item.kind` exists (`'book' | 'audio' | 'video'`) but nothing reads it yet.

- **Groundwork, for big files:**
  - Hash files as a stream: `hashBlob` in `common/src/backend.ts` reads the whole file into memory (WebCrypto has no incremental digest, so a wasm or JS SHA-256 in a worker), and the native sides likewise.
  - Serve `Range` on `/library/files/…` (desktop's `app://` handler, Android, the server's raw file endpoints; iOS has it) so players can seek.
  - Keep sync, backups and freeing files streaming, and let phones keep media files only when asked (`keepFiles`). A browser's OPFS quota limits a media library there; the desktop app and M4 are its homes.
- **Model (a schema bump):**
  - `ItemKind` gains `'image'`; `FormatInfo` gains a `kind`, so imports sort files by medium.
  - One metadata bag for every kind, its keys per kind in `bookFields.ts` (`duration`, `narrator` as a creator role, `trackNumber`, `disc`, `season`, `episode`, `taken`, `camera`, `location`…).
  - An item's content across several files in order (`FileRef.part`), and per-file details (`FileRef.metadata`) for an album's tracks.
  - Positions as seconds in `ReadingPosition.locator`.
- **Parsing, in tools (`media/` beside `formats/`, browser and CLI alike):** `music-metadata` (ID3, m4b chapters, embedded art), `mp4box.js` or `mediainfo.js` for video, `exifr` for images; covers from embedded art, a poster, a frame of the video, or the image itself.
- **Audiobooks:** an item per book, one m4b or ordered parts; Open Library, series and Currently Reading as for books; a player with chapters, speed and a sleep timer.
- **Music:** an item per album, its tracks as files with their own titles, numbers and durations; series as the artist's discography where wanted; a play queue; MusicBrainz lookup on request.
- **Video:** an item per film; a show's episodes as items in its series (`seriesIndex`, `season`); subtitles as files (`.srt` turned into WebVTT); TMDB lookup on request (needs a key); transcoding (mkv, HEVC) with ffmpeg on the M4 server, and in the browser only where ffmpeg.wasm is quick enough.
- **Images:** an item per image, titled from its file until named; albums as tags and the user's categories (an image in many); browsing by date taken and place beside the usual levels; duplicates by perceptual hash as well as by file hash in `dedupe.ts`; HEIC converted to JPEG; thumbnails as covers already are; a lightbox viewer.
- **Players and the apps:** `<audio>` and `<video>` in `reader/`, audio playing on while the library is browsed; background playback and lock-screen controls natively (Android's `MediaSession` service, iOS's `audio` background mode).
- **Library:** a kind level above the browse path (Books, Audiobooks, Music, Video, Images), `kind:` in the search, fields shown by kind in a book's details and the list's columns.
- **Text:** lyrics and subtitles indexed by `fulltext/`; transcripts of audio with M8's background jobs.
- **Connections:** folders and players with their own templates and formats; Audiobookshelf; Subsonic (OpenSubsonic) served live as the OPDS feed is (`opdsServer.ts`), so music players stream from M4; Jellyfin or Plex libraries read; a phone's camera roll read into images.

**Done when:** I import an audiobook in parts and listen on the phone from where I stopped on the desktop; import an album and play it through; watch a film with subtitles that seeks smoothly; import a folder of photos, browse them by date and find their duplicates.

## Unscheduled

Small things to pick up when they're wanted.

- **Facets:** a sidebar with counts per tag, author and format, each adding its term to the search.
- **Reading Calibre's `metadata.db`** for what a folder import misses: custom columns, read status, books with no file.

## Open questions

- Where is the source of CrossPoint's account plugin, and can it fulfill `.acsm` files? That decides whether nexlibris ever needs the device's key.
- How should an `https://`-hosted browser client reach CrossPoint? Through the server, HTTPS on CrossPoint, or only from `localhost`, the server and the apps (Android relays the calls natively).
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
