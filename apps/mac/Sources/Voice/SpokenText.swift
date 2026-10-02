import Foundation

/// Text as it should be read aloud: no markdown, abbreviations and symbols spelled out.
enum SpokenText {
    static func prepare(_ text: String, lang: String) -> String {
        var s = text
        for (pattern, template) in [(#"\*\*?([^*]+)\*\*?"#, "$1"), (#"`([^`]+)`"#, "$1")] {
            s = s.replacingOccurrences(of: pattern, with: template, options: .regularExpression)
        }
        // Names the models have never seen are respelled the way they are said.
        let words: [(String, String)] = lang == "fr"
            ? [("Brightky", "Braïtki"), ("%", " pour cent"), ("€", " euros"), ("&", " et "), ("FCFA", " francs CFA"), (" h ", " heures ")]
            : [("Brightky", "Bright-key"), ("%", " percent"), ("€", " euros"), ("&", " and "), ("FCFA", " CFA francs")]
        for (a, b) in words { s = s.replacingOccurrences(of: a, with: b) }
        return s.replacingOccurrences(of: #"\s+"#, with: " ", options: .regularExpression).trimmingCharacters(in: .whitespaces)
    }
}

/// Word error rate (Levenshtein over words), to measure how well a voice is understood.
enum WordErrorRate {
    static func of(reference: String, hypothesis: String) -> Double {
        func words(_ s: String) -> [String] {
            s.lowercased().replacingOccurrences(of: "’", with: "'")
                .components(separatedBy: CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "'")).inverted)
                .filter { !$0.isEmpty }
        }
        let r = words(reference), h = words(hypothesis)
        guard !r.isEmpty else { return h.isEmpty ? 0 : 1 }
        var d = Array(0...h.count)
        for i in 1...r.count {
            var prev = d[0]
            d[0] = i
            for j in stride(from: 1, through: h.count, by: 1) {
                let tmp = d[j]
                d[j] = min(d[j] + 1, d[j - 1] + 1, prev + (r[i - 1] == h[j - 1] ? 0 : 1))
                prev = tmp
            }
        }
        return Double(d[h.count]) / Double(r.count)
    }
}
