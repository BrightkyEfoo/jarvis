#!/usr/bin/env bash
# Builds Jarvis.app (menu bar + dashboard + voice + computer control): native Swift package.
# Neural voice models (~1.5 GB) are downloaded by the app on first use, not here.
set -euo pipefail
cd "$(dirname "$0")"
APP="build/Jarvis.app"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS"
cp Info.plist "$APP/Contents/Info.plist"
mkdir -p "$APP/Contents/Resources"
# Swift package (FluidAudio for the neural voice stack, pinned in Package.resolved).
swift build -c release --product jarvis-app
BIN="$(swift build -c release --show-bin-path)"
cp "$BIN/jarvis-app" "$APP/Contents/MacOS/jarvis-app"
for bundle in "$BIN"/*.bundle; do [ -d "$bundle" ] && cp -R "$bundle" "$APP/Contents/Resources/"; done
# Reference clips of the cloned French voices (CC BY 4.0, see Resources/voices/CREDITS.md).
[ -d Resources/voices ] && cp -R Resources/voices "$APP/Contents/Resources/voices"

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
