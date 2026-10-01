#!/usr/bin/env bash
# Builds Jarvis.app (menu bar + dashboard + push-to-talk voice): native Swift, 0 MB download.
set -euo pipefail
cd "$(dirname "$0")"
APP="build/Jarvis.app"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS"
cp Info.plist "$APP/Contents/Info.plist"
SOURCES=()
while IFS= read -r f; do SOURCES+=("$f"); done < <(find Sources -name '*.swift' | sort)
swiftc -O -wmo -swift-version 5 -parse-as-library -target arm64-apple-macos15.0 \
  "${SOURCES[@]}" -o "$APP/Contents/MacOS/jarvis-app"

# Stable local identity (ops: apps/mac/signing-setup.sh) keeps the Microphone/Speech permissions
# across rebuilds; without it, an ad-hoc signature makes macOS ask again after each build.
KC="$HOME/Library/Application Support/Jarvis/signing/jarvis-signing.keychain-db"
HASH_FILE="$HOME/Library/Application Support/Jarvis/signing/identity.sha1"
if [ -f "$KC" ] && [ -f "$HASH_FILE" ]; then
  security unlock-keychain -p "$(cat "$HOME/Library/Application Support/Jarvis/signing/.kc")" "$KC"
  codesign --force --sign "$(cat "$HASH_FILE")" --keychain "$KC" --identifier cm.brightkyefoo.jarvis "$APP"
  echo "signé avec l'identité locale stable"
else
  codesign --force --sign - --identifier cm.brightkyefoo.jarvis "$APP"
fi
echo "✔ $APP ($(du -sh "$APP" | cut -f1))"
