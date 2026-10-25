# On shipping the apps

What it would take to publish the Android and iOS apps: Google Play, the App Store, and F-Droid (or its faster
alternatives). Written October 2026, against the state of the repo then; PLAN.md's M7 tracks the work itself.

## Where things stand

- **Android** runs on real hardware (a Pixel 7a). Missing: release signing (PLAN.md M7), store packaging.
- **iOS** has never run in Xcode or on a device. `ios/NexlibrisKit` builds and passes its tests on macOS and the shell
  typechecks against Mac Catalyst, but PLAN.md's M7 device checklist (storage, import, saving, library and sync folders,
  network sync, Bluetooth hosting, ISBN scanning, a CrossPoint reader) comes before any store work.

## Both stores

- **Accounts:** Apple Developer Program $99/year; Google Play $25 once.
- **Privacy policy URL**, plus Apple's privacy label and Play's Data safety form. Both are easy: no analytics, the
  library stays local, and the network is used only for Open Library, OPDS catalogs and the user's own server, each on
  the user's action.
- **Listing:** screenshots (phone, and iPad since `TARGETED_DEVICE_FAMILY` is `1,2`), description, age rating,
  support URL.
- **Account deletion:** Apple's guideline 5.1.1(v) requires an app that can create an account to delete one in the app.
  The apps sign in to a server whose sign-up may be open, and deleting an account is still undone (PLAN.md M4). Either
  build deletion or make sure the apps only sign in, never sign up.

## Google Play

1. **Release signing:** an upload keystore, a `signingConfigs.release` read from `keystore.properties` or the
   environment (never committed), and Play App Signing.
2. **An AAB:** `npm run build`, then `./gradlew bundleRelease` (`copyWebApp` needs `client/dist`).
3. **Versions:** `versionCode` must rise with every upload; set it from a tag or build number in a script or CI.
4. **Target SDK:** 36, current.
5. **Permissions:** camera and Bluetooth advertise/connect are justified; expect a declaration question on Bluetooth.
6. **Cleartext:** `network_security_config.xml` allows plain http to every host (for the LAN sync hub, whose address
   isn't known ahead). Acceptable, but reviewers notice it.
7. **Optional:** R8 (`isMinifyEnabled = true`); the Kotlin side is small, so it gains little.

**Testing requirement:** personal developer accounts created after November 2023 must run a closed test with at least
12 testers opted in for 14 days in a row before applying for production. Organization accounts (D-U-N-S number) are
exempt. This is the slowest step; start it early.

## App Store

1. **Run it:** the M7 device checklist above.
2. **Signing:** `DEVELOPMENT_TEAM` in `ios/project.yml` (then `xcodegen`), register `org.nexlibris.app`, create the
   app in App Store Connect.
3. **Privacy manifest:** add `PrivacyInfo.xcprivacy`, declaring the required-reason APIs used (file timestamps and
   UserDefaults almost certainly).
4. **Export compliance:** `ITSAppUsesNonExemptEncryption` = `false` in `Info.plist` (only HTTPS and system crypto),
   or every build asks.
5. **App Transport Security:** `NSAllowsArbitraryLoads` is on. `NSAllowsLocalNetworking` already covers the LAN hub
   and readers; dropping arbitrary loads means plain-http OPDS servers stop loading. Keep it and justify it, or drop it.
6. **Guideline 4.2 (minimum functionality):** WebView apps draw scrutiny. The native features (file storage, Files
   integration, Bluetooth hosting, the camera) should carry it; say so in the review notes, and give reviewers a test
   server account or note that none is needed.
7. **Icons:** check `Assets.xcassets` has the 1024px marketing icon; `scripts/make-icons.py` could write the iOS set
   too, as it does Android's.
8. **Upload:** Xcode's Organizer, or `xcodebuild archive` and `-exportArchive`.

**Testing requirement:** none. TestFlight is optional: internal testers (up to 100, members of the App Store Connect
team) get builds without review; external testers (up to 10,000) after a short beta review of the first build. A build
can go straight to App Review, which usually takes a day or two.

## F-Droid

The licence is fine (MIT) and nothing uses Google Play Services. The work is being built from source on F-Droid's
servers, and one dependency that isn't free.

- **UnRAR (the blocker):** CBR reading uses `node-unrar-js`, whose `unrar.wasm` is RARLab's UnRAR, not free software
  (Debian puts it in non-free). Options: an F-Droid flavour without CBR; replacing it everywhere with libarchive built
  as wasm (BSD, reads RAR including RAR 5); or keeping it under the `NonFreeDep` anti-feature, if reviewers accept it at
  all. Writing RAR (`tools/src/formats/rar.ts`, stored files) uses no UnRAR code and is fine. Settle this first.
- **The build recipe** (a merge request to `fdroiddata`): install Node 24, `npm ci` and `npm run build` from the repo
  root (the workspace links need it), then `./gradlew assembleRelease`.
- **The scanner** flags prebuilt binaries: `gradle-wrapper.jar`, `node_modules`' native modules and wasm. Expect
  `scandelete` for `node_modules` and justification for the rest. `zxing-wasm` (Apache, but prebuilt; Android's
  WebView has `BarcodeDetector`, so it may be droppable there) and pdf.js's decoders may be asked to build from source.
- **Signing:** F-Droid signs with its own key by default, so its build and a Play or GitHub build can't update each
  other (switching means uninstalling, losing a library not in a folder the user picked). Reproducible builds let it
  publish your signature instead, but a Vite bundle inside the APK makes byte-identical builds hard.
- **Versions:** tag releases (`v0.1.0`) with `AutoUpdateMode: Version` and `UpdateCheckMode: Tags`; `versionCode` rises
  with each tag.
- **Listing:** Fastlane metadata in the repo, `fastlane/metadata/android/en-US/` (title, short and full description,
  `images/icon.png`, phone screenshots, `changelogs/<versionCode>.txt`).
- **Anti-features:** possibly `NonFreeDep` (UnRAR); `NonFreeNet` is unlikely, Open Library being free software.

**Faster alternatives:**
- **IzzyOnDroid:** an F-Droid-compatible repo taking the signed APK from GitHub Releases, no build recipe. It scans for
  trackers and non-free libraries (UnRAR may still come up). Days rather than weeks.
- **A repo of our own:** `fdroidserver`, hosted on GitHub Pages, added to F-Droid clients by URL.
- **Plain sideloading:** a signed APK on GitHub Releases skips every store.

## Effort

| Target | Work | Waiting |
| --- | --- | --- |
| Google Play | about a day: signing, AAB, listing, privacy policy | 14-day closed test, if the account needs it |
| App Store | device testing (the unknown), then about a day of packaging | review, a day or two, more if 4.2 or account deletion comes up |
| IzzyOnDroid | an afternoon, once release signing exists | days |
| F-Droid | a few days: UnRAR, recipe, scanner exceptions | review of the `fdroiddata` merge request, often weeks |

## Code changes to make first

- Android release signing config (needed by Play, IzzyOnDroid and sideloading).
- iOS `PrivacyInfo.xcprivacy` and `ITSAppUsesNonExemptEncryption`.
- iOS icons from `scripts/make-icons.py`.
- A decision on `NSAllowsArbitraryLoads`.
- A decision on UnRAR, if F-Droid is wanted.
- Account deletion in the apps, or no sign-up from them.
