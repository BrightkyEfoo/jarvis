#!/usr/bin/env bash
# Builds "Jarvis Voice.app": native Swift, Apple on-device speech + system voices (0 MB download).
set -euo pipefail
cd "$(dirname "$0")"
APP="build/Jarvis Voice.app"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS"
cp Info.plist "$APP/Contents/Info.plist"
swiftc -O -wmo -swift-version 5 -parse-as-library -target arm64-apple-macos14.0 \
  Sources/*.swift -o "$APP/Contents/MacOS/jarvis-voice"
# Ad-hoc signature: gives the app its own identity for the Microphone / Speech permissions.
codesign --force --sign - --identifier cm.brightkyefoo.jarvis.voice "$APP"
echo "✔ $APP ($(du -sh "$APP" | cut -f1))"
