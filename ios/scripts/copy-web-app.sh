#!/bin/sh
# Copies the built web app (client/dist, from `npm run build` at the repository root) into the app as www/,
# as the Android build copies it into its assets.
set -eu
dist="$SRCROOT/../client/dist"
if [ ! -f "$dist/index.html" ]; then
  echo "error: $dist has no web app. Run npm run build at the repository root first." >&2
  exit 1
fi
target="$TARGET_BUILD_DIR/$UNLOCALIZED_RESOURCES_FOLDER_PATH/www"
mkdir -p "$target"
rsync -a --delete "$dist/" "$target/"
