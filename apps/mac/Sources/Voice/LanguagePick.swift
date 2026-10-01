import Foundation
import NaturalLanguage

/// One recognizer's reading of the same audio.
struct Candidate {
    let lang: String  // "fr" | "en"
    let text: String
    /// Mean segment confidence (0 when the recognizer gave no final result).
    let confidence: Float
}

/// Brightky speaks French or English: both recognizers hear the same audio, the most plausible
/// reading wins. Everything here runs on device (NaturalLanguage, no download).
enum LanguagePick {
    static func probability(of lang: String, in text: String) -> Double {
        let r = NLLanguageRecognizer()
        r.languageConstraints = [.french, .english]
        r.processString(text)
        return r.languageHypotheses(withMaximum: 2)[lang == "fr" ? .french : .english] ?? 0
    }

    static func score(_ c: Candidate, prefer: String) -> Double {
        Double(c.confidence) * 0.5 + probability(of: c.lang, in: c.text) * 0.5 + (c.lang == prefer ? 0.05 : 0)
    }

    static func choose(_ candidates: [Candidate], prefer: String) -> Candidate? {
        candidates
            .filter { !$0.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
            .max { score($0, prefer: prefer) < score($1, prefer: prefer) }
    }

    /// Language of a reply sentence, to pick the voice. Short fragments follow the conversation.
    static func replyLanguage(_ text: String, hint: String) -> String {
        if text.split(separator: " ").count < 4 { return hint }
        let r = NLLanguageRecognizer()
        r.languageConstraints = [.french, .english]
        r.languageHints = hint == "fr" ? [.french: 0.7, .english: 0.3] : [.english: 0.7, .french: 0.3]
        r.processString(text)
        switch r.dominantLanguage {
        case .english?: return "en"
        case .french?: return "fr"
        default: return hint
        }
    }
}
