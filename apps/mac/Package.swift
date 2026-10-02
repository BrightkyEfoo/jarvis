// swift-tools-version: 6.0
import PackageDescription

// Jarvis.app: menu bar, dashboard, voice and computer control in one process.
// FluidAudio brings the neural voice stack on CoreML (Parakeet ASR, PocketTTS / Kokoro TTS),
// pinned to a commit; models download once (~/.cache/fluidaudio, ~/Library/Application Support/FluidAudio).
let package = Package(
    name: "JarvisApp",
    platforms: [.macOS(.v15)],
    dependencies: [
        // v0.17.5, pinned by commit (a tag can move; a commit cannot).
        .package(url: "https://github.com/FluidInference/FluidAudio.git", revision: "0b1f46289fe27d95b5e66ad8be46e64f5ee02ae7"),
    ],
    targets: [
        .executableTarget(
            name: "jarvis-app",
            dependencies: [.product(name: "FluidAudio", package: "FluidAudio")],
            path: "Sources"
        ),
    ],
    swiftLanguageModes: [.v5]
)
