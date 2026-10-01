# nexlibris

A library manager for ebooks (and later other media) that runs in the browser and on Android. Early work in progress; see [PLAN.md](PLAN.md).

## Setup

Needs Node 24 (`nvm use`) and a sibling checkout of [epubierjs](../epubierjs) at `../epubierjs`.

```sh
npm install
```

## Commands

```sh
npm run dev          # web app at http://localhost:5173
npm run build        # web app → client/dist
npm test             # all workspaces
npm run typecheck

npm run android          # debug APK (android/app/build/outputs/apk/debug)
npm run android:install  # build and install on a connected device
```

The Android build needs the Android SDK and JDK 17+ (e.g. `export JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home"`). Native unit tests: `cd android && ./gradlew testDebugUnitTest`.
