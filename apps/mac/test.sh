#!/usr/bin/env bash
# Pure-logic tests (sentence chunking, cleaning, language choice). No microphone, no permissions.
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p build
swiftc -O -swift-version 5 -parse-as-library -target arm64-apple-macos15.0 \
  Sources/Voice/TextChunker.swift Sources/Voice/LanguagePick.swift Sources/Voice/Confirmation.swift Sources/Voice/Wording.swift Sources/Voice/SpokenText.swift Sources/Voice/WakeWord.swift Sources/Actuator/Guard.swift Sources/Actuator/Osa.swift Tests/VoiceTests.swift -o build/voice-tests
./build/voice-tests
