import Foundation

/// Turns streamed model text into speakable sentences, as early as possible, so the voice can
/// start on the first sentence while the model is still writing the rest.
struct SpeechChunker {
    private var buffer = ""
    /// A long sentence without punctuation is cut at a comma or a space past this length.
    static let maxChunk = 180

    mutating func push(_ text: String) -> [String] {
        buffer += text
        return drain(final: false)
    }

    mutating func flush() -> [String] {
        drain(final: true)
    }

    private mutating func drain(final: Bool) -> [String] {
        // Code blocks are never read aloud; an unclosed fence is held until it closes.
        var ready = buffer
        var held = ""
        while let open = ready.range(of: "```") {
            if let close = ready.range(of: "```", range: open.upperBound..<ready.endIndex) {
                ready.replaceSubrange(open.lowerBound..<close.upperBound, with: " (code omis). ")
            } else {
                held = final ? "" : String(ready[open.lowerBound...])
                ready = String(ready[..<open.lowerBound]) + (final ? " (code omis). " : "")
                break
            }
        }

        var out: [String] = []
        var start = ready.startIndex
        var i = ready.startIndex
        while i < ready.endIndex {
            let c = ready[i]
            let next = ready.index(after: i)
            let atBoundary: Bool
            if c == "\n" {
                atBoundary = true
            } else if ".!?…".contains(c) {
                atBoundary = next == ready.endIndex ? final : ready[next].isWhitespace
            } else {
                atBoundary = false
            }
            if atBoundary {
                append(String(ready[start..<next]), to: &out)
                start = next
            }
            i = next
        }

        var rest = String(ready[start...])
        while rest.count > Self.maxChunk {
            let cutAt = rest.index(rest.startIndex, offsetBy: Self.maxChunk)
            let head = rest[..<cutAt]
            let split = head.range(of: ", ", options: .backwards)?.upperBound
                ?? head.range(of: " ", options: .backwards)?.upperBound
                ?? cutAt
            append(String(rest[..<split]), to: &out)
            rest = String(rest[split...])
        }
        if final {
            append(rest, to: &out)
            rest = ""
        }
        buffer = rest + held
        return out
    }

    private func append(_ raw: String, to out: inout [String]) {
        let s = Self.clean(raw)
        if s.contains(where: { $0.isLetter || $0.isNumber }) { out.append(s) }
    }

    /// Markdown, tags, links and emojis read terribly aloud: strip them.
    static func clean(_ s: String) -> String {
        var t = s
        let rules: [(String, String)] = [
            (#"</?external_data[^>]*>"#, " "),
            (#"\[([^\]]+)\]\([^)]+\)"#, "$1"),
            (#"https?://\S+"#, " "),
            (#"`([^`]*)`"#, "$1"),
            (#"(?m)^\s*#{1,6}\s*"#, ""),
            (#"(?m)^\s*(?:[-*•]|\d+[.)])\s+"#, ""),
            (#"\*\*|__|\*"#, ""),
            (#"\|"#, ", "),
            (#"(?<=\w)_(?=\w)"#, " "),
        ]
        for (pattern, template) in rules {
            t = t.replacingOccurrences(of: pattern, with: template, options: .regularExpression)
        }
        t = String(String.UnicodeScalarView(t.unicodeScalars.filter { !$0.properties.isEmojiPresentation }))
        return t.replacingOccurrences(of: #"\s+"#, with: " ", options: .regularExpression)
            .trimmingCharacters(in: .whitespaces)
    }
}
