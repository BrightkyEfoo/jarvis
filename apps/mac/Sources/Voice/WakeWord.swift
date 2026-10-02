import Foundation

/// Does an utterance address Jarvis? Speech recognition writes the name a few ways (Jervis, Javis,
/// Charvis…), close spellings count. Jarvis is addressed when the name is:
/// - at the start, after any greeting or filler ("Hello Jarvis", "Bonsoir Jarvis, …",
///   "Excuse-moi Jarvis, …", "OK Google… non, Jarvis"),
/// - or at the end ("Quelle heure est-il, Jarvis ?"),
/// - or set apart by commas ("Alors, Jarvis, on en est où ?").
/// A mere mention ("j'ai parlé à Jarvis hier", "c'est Jarvis qui…") is not a command.
enum WakeWord {
    enum Match: Equatable {
        case none
        case alone
        case command(String)
    }

    /// Greetings, politeness and fillers that may come before the name (normalised, no accents).
    private static let lead: Set<String> = [
        "hey", "he", "eh", "hi", "hello", "hallo", "hola", "yo", "oh", "ok", "okay", "dis", "dites", "salut", "bonjour",
        "bonsoir", "coucou", "allo", "alors", "et", "euh", "heu", "bon", "bah", "ben", "ecoute", "ecoutemoi", "excuse",
        "excusemoi", "excusez", "pardon", "please", "stp", "svp", "good", "morning", "evening", "afternoon", "night",
        "wake", "up", "debout", "reveilletoi", "ca", "va", "mon", "cher", "mister", "monsieur", "my", "dear", "merci",
        "thanks", "thank", "you", "aussi", "toi", "et", "voila", "bien", "sur", "oui", "non", "attends", "wait",
    ]
    /// Words that make the name an object, not someone spoken to ("parlé à Jarvis", "c'est Jarvis").
    private static let mention: Set<String> = [
        "a", "au", "aux", "de", "du", "des", "le", "la", "les", "l", "un", "une", "avec", "pour", "sur", "chez", "par",
        "sans", "vers", "est", "cest", "etait", "appelle", "nomme", "to", "with", "about", "the", "of", "for", "from",
        "is", "was", "called", "named", "ask", "tell", "que", "qui", "dont",
    ]
    private static let spellings: Set<String> = ["jarvis", "jarvice", "jervis", "jarviss", "jarvisse", "javis", "jarvi", "djarvis", "charvis", "harvis", "garvis", "jarvise"]

    static func normalize(_ word: String) -> String {
        word.folding(options: [.diacriticInsensitive, .caseInsensitive], locale: .init(identifier: "fr_FR"))
            .filter { $0.isLetter }
    }

    static func isName(_ word: String) -> Bool {
        let w = normalize(word)
        return spellings.contains(w) || (w.count >= 5 && w.count <= 7 && distance(w, "jarvis") <= 1)
    }

    private static let edge = CharacterSet(charactersIn: " ,.;:!?-–—…\"'«»").union(.whitespaces)

    static func match(_ text: String) -> Match {
        let words = text.split(whereSeparator: { $0.isWhitespace }).map(String.init)
        guard let i = words.firstIndex(where: isName) else { return .none }
        let before = Array(words[..<i]), after = Array(words[(i + 1)...])
        let prev = before.last.map(normalize)
        let clean = { (ws: [String]) in ws.joined(separator: " ").trimmingCharacters(in: edge) }
        let hasWords = { (s: String) in s.contains(where: { $0.isLetter }) }

        // 1. Name opening the sentence, after greetings only: "Hello Jarvis, ouvre Teams".
        if before.allSatisfy({ lead.contains(normalize($0)) || normalize($0).isEmpty }) {
            let rest = clean(after)
            return hasWords(rest) ? .command(rest) : .alone
        }
        if let prev, mention.contains(prev) { return .none }
        // 2. Name closing the sentence: "Quelle heure est-il, Jarvis ?".
        if !hasWords(clean(after)) {
            let rest = clean(before)
            return hasWords(rest) ? .command(rest) : .alone
        }
        // 3. Name between commas: "Alors, Jarvis, on en est où ?".
        if before.last?.hasSuffix(",") == true, words[i].hasSuffix(",") {
            let rest = clean(before.filter { !lead.contains(normalize($0)) } + after)
            return hasWords(rest) ? .command(rest) : .alone
        }
        return .none
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
