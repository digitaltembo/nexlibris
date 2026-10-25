# Releasing

A release is a GitHub release. Publishing one tagged `v<major>.<minor>.<patch>` (a pre-release such as
`v0.3.0-beta.1` too) runs `.github/workflows/release.yml`, which:

1. **Verifies** everything first (`verify.yml`, which also runs on every pull request): lint, typecheck,
   every workspace's tests, the builds and Storybook; the Docker image, built and started; Android's unit tests and lint; NexlibrisKit's Swift tests and
   an unsigned iOS build; the Tauri app's Rust tests. Nothing is built for release until all of it passes.
2. **Stamps the version** from the tag (`scripts/release/version.mjs`) on the packages, the Tauri app, Android's
   `versionName`/`versionCode` and iOS's `MARKETING_VERSION`/build number. Nothing is committed: the tag is the
   version, and the repository stays at `0.0.0`.
3. **Builds and publishes**, each part on its own (one failing doesn't stop the others):

| Part | What | Where |
| --- | --- | --- |
| npm | `@nexlibris/tools`, `@nexlibris/crosspoint-tools` (compiled, with declarations), `@nexlibris/cli`, and `@nexlibris/server` (its bundle with the web app) (`scripts/release/npm.mjs`) | npm, `latest` (pre-releases `next`) |
| Docker | the server's image, for linux/amd64 and linux/arm64 | `ghcr.io/<owner>/nexlibris`, tagged `X.Y.Z`, `X.Y` and `latest` (a pre-release only `X.Y.Z-…`) |
| Android | signed APK and AAB | `nexlibris.apk` on the release (the About screen links to the latest one); the AAB as a workflow artifact, for Google Play |
| iOS | archive, uploaded | TestFlight |
| Desktop | the Tauri app: macOS (universal `.dmg`/`.app`), Windows (`.msi`, `-setup.exe`), Linux (`.deb`, `.rpm`, `.AppImage`) | on the release |
| Web | the app, without a server (`VITE_STATIC_HOST`) | GitHub Pages |

Run by hand (Actions → Release → Run workflow, with a version), it's a **dry run**: all of the above is built and
kept as workflow artifacts, and nothing is published.

To try a part locally: `node scripts/release/version.mjs v1.2.3` (then `git checkout -- .` to undo it),
`npm run build -w client && npm run build -w server && npm run build -w cli && node scripts/release/npm.mjs` (packs into `dist-npm/`), `docker build -t nexlibris .`,
`cd android && ./gradlew assembleRelease -PversionCode=1002003 -PversionName=1.2.3`, `npm run bundle -w tauri`,
`NEXLIBRIS_BASE=/nexlibris/ VITE_STATIC_HOST=true npm run build -w client`.

## One-time setup

Each part works, or is skipped with a notice, without its secrets; set them (Settings → Secrets and variables →
Actions) as each becomes ready.

### GitHub Pages

Settings → Pages → Source: **GitHub Actions**. The app is served at `https://<owner>.github.io/<repository>/`.
With a custom domain, set the repository variable `PAGES_BASE` to `/`.

The web app runs entirely in the browser (the library in its storage, or a folder in Chrome and Edge); without a
server there's no account, and it syncs with other devices only directly (Bluetooth, a folder, the desktop app on
the same network, though a page served over https can't call the desktop app's plain-http hub).

### Docker

Nothing to set up: the workflow pushes with its own token. The first push makes the package
`ghcr.io/<owner>/nexlibris`; check under the profile's Packages that it's public and linked to this repository
(Package settings → Change visibility), or pulling it needs a sign-in.

### npm

The `@nexlibris` scope has to exist on npm (an organization, or the user `nexlibris`).

- **First release:** an npm access token that can publish to the scope, as the secret `NPM_TOKEN`.
- **Afterwards (better):** on npmjs.com, each package's Settings → Trusted publishing → GitHub Actions, for this
  repository and the workflow `release.yml`. Then delete `NPM_TOKEN`: npm accepts the workflow itself, with
  provenance.

A version that's already published is skipped, so a release can be re-run.

### Android

A release keystore, made once and **kept safe**: every update must be signed with it, or phones won't install it over
the old one.

```sh
keytool -genkeypair -v -keystore nexlibris-release.jks -alias nexlibris -keyalg RSA -keysize 4096 -validity 10000
base64 -i nexlibris-release.jks | pbcopy   # → the secret ANDROID_KEYSTORE_BASE64
```

Secrets: `ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS` (`nexlibris`),
`ANDROID_KEY_PASSWORD`. Without them the APK is built unsigned and not attached. Locally, `android/keystore.properties`
(`storeFile`, `storePassword`, `keyAlias`, `keyPassword`; ignored by git) signs `./gradlew assembleRelease` the same
way. For Google Play later, enrol the same key in Play App Signing (OnShippingApps.md).

### iOS

There's no way to hand out an iOS app without Apple: until there's a developer account, the job only notes that
it's skipped (verify still builds the app, unsigned). With one (Apple Developer Program, $99 a year):

1. Register the bundle ID `org.nexlibris.app` and create the app in App Store Connect.
2. App Store Connect → Users and Access → Integrations → App Store Connect API: a team key with the Admin role
   (Xcode's cloud signing makes certificates and profiles with it, which App Manager can't).
3. Secrets: `APPLE_TEAM_ID`, `APP_STORE_CONNECT_KEY_ID`, `APP_STORE_CONNECT_ISSUER_ID`, and `APP_STORE_CONNECT_KEY`
   (the `.p8` file's contents).

Each release is then archived, signed automatically (Xcode makes the certificate and profile with the key) and
uploaded to TestFlight. A TestFlight **public link** (TestFlight → External Testing → a group → Public Link, after
Apple's short beta review of the first build) is then the iOS download: set it as the repository variable
`DOWNLOAD_IOS`, and the next release's builds show it on the About screen (`client/src/library/downloads.ts`).
OnShippingApps.md has what the App Store itself needs.

### macOS desktop app

Without a certificate the app is signed ad hoc: macOS refuses to open it from a double-click the first time
(right-click → Open, or System Settings → Privacy & Security → Open Anyway). With the developer account:

- A **Developer ID Application** certificate, exported as a `.p12`: secrets `APPLE_CERTIFICATE` (its base64),
  `APPLE_CERTIFICATE_PASSWORD`, and `APPLE_SIGNING_IDENTITY` (`Developer ID Application: <Name> (<TEAM>)`).
- Notarization uses the App Store Connect key above.

Windows builds are unsigned (SmartScreen warns on first run); signing them needs a code-signing certificate, not
set up yet.

## Cutting a release

1. Optionally, run Verify on `main` by hand (Actions → Verify → Run workflow) to catch problems before tagging;
   the release runs it again either way.
2. GitHub → Releases → Draft a new release → a new tag `vX.Y.Z` on `main`, notes, Publish (tick pre-release for
   `vX.Y.Z-beta.N`). GitHub's `releases/latest`, which the About screen's downloads link to, skips pre-releases,
   as do npm's `latest` and Docker's `latest`: make the first release a full one.
3. Watch Actions → Release. Desktop installers and the APK appear on the release as their jobs finish; the site
   deploys once verified.
