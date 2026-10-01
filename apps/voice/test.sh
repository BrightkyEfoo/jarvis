#!/usr/bin/env bash
# Pure-logic tests (sentence chunking, cleaning, language choice). No microphone, no permissions.
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p build
swiftc -O -swift-version 5 -parse-as-library -target arm64-apple-macos14.0 \
  Sources/TextChunker.swift Sources/LanguagePick.swift Sources/Confirmation.swift Tests/VoiceTests.swift -o build/voice-tests
./build/voice-tests
