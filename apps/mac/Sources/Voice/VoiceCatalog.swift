import Foundation

/// Neural voices offered to Brightky (mostly male, French and English). English voices are
/// PocketTTS built-ins; French male voices are clones of recordings whose speakers donated them
/// for voice cloning (CC0, kyutai/tts-voices), shipped in Resources/voices — see CREDITS.md.
/// PocketTTS forbids cloning anyone without explicit consent: only such recordings go here.
enum VoiceCatalog {
    /// Measured on the same sentence: Samuel 6.4 s (Fabien 9.1 s), Michael 8.5 s (Charles 9.9 s).
    static let defaults = ["fr": "samuel", "en": "michael"]

    static let all: [NeuralVoiceSpec] = [
        // Français — voix données explicitement pour le clonage (CC0)
        .init(id: "fabien", lang: "fr", label: "Fabien — posé", male: true, builtin: nil, reference: "fr-fabien.wav"),
        .init(id: "theo", lang: "fr", label: "Théo — médium", male: true, builtin: nil, reference: "fr-theo.wav"),
        .init(id: "samuel", lang: "fr", label: "Samuel — chaleureux", male: true, builtin: nil, reference: "fr-samuel.wav"),
        .init(id: "erick", lang: "fr", label: "Erick — grave", male: true, builtin: nil, reference: "fr-erick.wav"),
        .init(id: "estelle", lang: "fr", label: "Estelle — féminine", male: false, builtin: "estelle", reference: nil),
        // English
        .init(id: "charles", lang: "en", label: "Charles — deep", male: true, builtin: "charles", reference: nil),
        .init(id: "javert", lang: "en", label: "Javert — deep", male: true, builtin: "javert", reference: nil),
        .init(id: "michael", lang: "en", label: "Michael — warm", male: true, builtin: "michael", reference: nil),
        .init(id: "peter", lang: "en", label: "Peter — narrator", male: true, builtin: "peter_yearsley", reference: nil),
        .init(id: "jean", lang: "en", label: "Jean — calm", male: true, builtin: "jean", reference: nil),
        .init(id: "paul", lang: "en", label: "Paul — bright", male: true, builtin: "paul", reference: nil),
        .init(id: "george", lang: "en", label: "George — light", male: true, builtin: "george", reference: nil),
        .init(id: "alba", lang: "en", label: "Alba — female", male: false, builtin: "alba", reference: nil),
    ]
}
