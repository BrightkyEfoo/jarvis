import Foundation

/// Does an utterance address Jarvis? "Jarvis, ouvre VS Code" → command; "Hey Jarvis" → wake only.
/// Speech recognition writes the name a few ways (Jervis, Javis, Charvis…): close spellings count,
/// but only as one of the first words, so a sentence merely mentioning Jarvis is not a command.
enum WakeWord {
    enum Match: Equatable {
        case none
        case alone
        case command(String)
    }

    private static let fillers: Set<String> = ["hey", "he", "hé", "eh", "ok", "okay", "dis", "salut", "bonjour", "allo", "allô", "yo", "oh", "hi", "hello", "et", "alors"]
    private static let spellings: Set<String> = ["jarvis", "jarvice", "jervis", "jarviss", "jarvisse", "javis", "jarvi", "djarvis", "charvis", "harvis", "garvis", "jarvise"]

    static func normalize(_ word: String) -> String {
        word.folding(options: [.diacriticInsensitive, .caseInsensitive], locale: .init(identifier: "fr_FR"))
            .filter { $0.isLetter }
    }

    static func isName(_ word: String) -> Bool {
        let w = normalize(word)
        return spellings.contains(w) || (w.count >= 5 && w.count <= 7 && distance(w, "jarvis") <= 1)
    }

    static func match(_ text: String) -> Match {
        let words = text.split(whereSeparator: { $0.isWhitespace }).map(String.init)
        var i = 0
        while i < min(words.count, 3), fillers.contains(normalize(words[i])) { i += 1 }
        guard i < words.count, isName(words[i]) else { return .none }
        let rest = words[(i + 1)...].joined(separator: " ")
            .trimmingCharacters(in: CharacterSet(charactersIn: " ,.;:!?-–—…").union(.whitespaces))
        return rest.contains(where: { $0.isLetter }) ? .command(rest) : .alone
    }

    /// Is what the microphone heard just Jarvis's own voice (room echo after it spoke)?
    static func isEcho(_ heard: String, of spoken: String) -> Bool {
        let words = { (s: String) in s.split(whereSeparator: { !$0.isLetter && !$0.isNumber }).map { normalize(String($0)) }.filter { $0.count > 2 } }
        let h = words(heard), said = Set(words(spoken))
        guard !h.isEmpty, !said.isEmpty else { return false }
        return Double(h.filter { said.contains($0) }.count) / Double(h.count) >= 0.6
    }

    private static func distance(_ a: String, _ b: String) -> Int {
        let a = Array(a), b = Array(b)
        var d = Array(0...b.count)
        for i in 1...a.count {
            var prev = d[0]
            d[0] = i
            for j in stride(from: 1, through: b.count, by: 1) {
                let tmp = d[j]
                d[j] = min(d[j] + 1, d[j - 1] + 1, prev + (a[i - 1] == b[j - 1] ? 0 : 1))
                prev = tmp
            }
        }
        return d[b.count]
    }
}
