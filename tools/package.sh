#!/bin/sh
# Builds a ready-to-install copy of the extension for other people: only the files
# Chrome needs, no source, tests or personal data. Output: build/applymate-<version>.zip
set -e
cd "$(dirname "$0")/.."
npm run build --silent
VERSION=$(node -p "require('./manifest.json').version")
OUT="build/applymate-$VERSION"
rm -rf "$OUT" "$OUT.zip"
mkdir -p "$OUT"
cp -R manifest.json content options fonts profile.sample.json "$OUT/"
mkdir -p "$OUT/dist" && cp dist/background.js "$OUT/dist/"
cp INSTALL.txt "$OUT/"
(cd build && zip -qr "applymate-$VERSION.zip" "applymate-$VERSION")
echo "$OUT.zip"
