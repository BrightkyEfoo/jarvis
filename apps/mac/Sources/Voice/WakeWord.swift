import Foundation

/// Does an utterance address Jarvis? Speech recognition writes the name a few ways (Jervis, Javis,
/// Charvis…), close spellings count. Jarvis is addressed when the name is:
/// - at the start, after greetings, fillers or a short lead-in ("Hello Jarvis", "Bon, Jarvis, …",
///   "Au fait Jarvis, …", "Alright Jarvis", "Franchement Jarvis, …"),
/// - or at the end ("Quelle heure est-il, Jarvis ?"),
/// - or set apart by commas ("Alors, Jarvis, on en est où ?").
/// Talking *about* Jarvis is not a command: "j'ai parlé à Jarvis", "le projet Jarvis",
/// "Jarvis est lent", "je pense que Jarvis…".
enum WakeWord {
    enum Match: Equatable {
        case none
        case alone
        case command(String)
    }

    /// Greetings, politeness, fillers and discourse markers that may come before the name
    /// (normalised: no accents, no punctuation; "Dis-moi" is checked as "dis" + "moi").
    private static let lead: Set<String> = [
        // greetings, politeness
        "hey", "he", "eh", "hi", "hello", "hallo", "hola", "yo", "wesh", "salut", "bonjour", "bonsoir", "rebonjour", "re",
        "coucou", "allo", "good", "morning", "evening", "afternoon", "night", "bonne", "journee", "soiree", "nuit", "matin",
        "please", "stp", "svp", "merci", "thanks", "thank", "pardon", "sorry", "excuse", "excusemoi", "excusez",
        // fillers, discourse markers
        "oh", "ah", "ok", "okay", "okey", "dacc", "daccord", "alright", "so", "well", "now", "right", "then", "also", "and",
        "um", "uh", "hmm", "hum", "euh", "heu", "bon", "bah", "ben", "bien", "alors", "et", "donc", "bref", "enfin", "sinon",
        "ensuite", "puis", "maintenant", "mais", "aussi", "voila", "oui", "ouais", "non", "nan", "yeah", "yes", "no", "nope",
        "franchement", "serieux", "parfait", "super", "top", "cool", "genial", "nickel", "impeccable", "bravo", "great",
        "perfect", "awesome",
        // calling for attention
        "dis", "dites", "ecoute", "ecoutez", "ecoutemoi", "listen", "look", "regarde", "regardez", "voyons", "attends",
        "attendez", "wait", "tiens", "tenez", "allez", "vas", "y", "vasy", "allezy", "wake", "up", "debout", "reveille",
        "reveilletoi", "quick", "question",
        // terms of address
        "mon", "ma", "cher", "chere", "vieux", "petit", "ami", "pote", "frere", "gars", "mister", "monsieur", "my", "dear",
        "buddy", "mate", "man", "dude", "bro", "toi", "moi", "you", "ca", "va",
    ]
    /// Multi-word lead-ins whose words would otherwise look like a mention ("au", "du", "s'il").
    private static let leadPhrases: [[String]] = [
        ["au", "fait"], ["du", "coup"], ["en", "fait"], ["a", "propos"], ["par", "contre"], ["d", "ailleurs"],
        ["s", "il", "te", "plait"], ["s", "il", "vous", "plait"], ["dis", "moi"], ["dites", "moi"], ["dis", "donc"],
        ["tu", "sais"], ["tu", "vois"], ["eh", "bien"], ["et", "bien"], ["c", "est", "bon"], ["ca", "y", "est"],
        ["j", "ai", "une", "petite", "question"], ["j", "ai", "une", "question"], ["une", "petite", "question"],
        ["une", "question"], ["by", "the", "way"], ["you", "know"], ["all", "right"], ["excuse", "me"],
        ["thank", "you"], ["one", "more", "thing"], ["i", "have", "a", "question"], ["hey", "there"],
    ]
    /// Words that make the name an object, not someone spoken to ("parlé à Jarvis", "c'est Jarvis").
    private static let mention: Set<String> = [
        "a", "au", "aux", "de", "du", "des", "le", "la", "les", "l", "un", "une", "avec", "pour", "sur", "chez", "par",
        "sans", "vers", "est", "cest", "etait", "appelle", "nomme", "to", "with", "about", "the", "of", "for", "from",
        "is", "was", "called", "named", "ask", "tell", "que", "qui", "dont", "d",
    ]
    /// A lead-in with these is a sentence, not a call: "je pense que…", "c'est…", "ton Jarvis…".
    private static let statement: Set<String> = [
        "je", "j", "il", "elle", "on", "nous", "ils", "elles", "c", "ce", "cet", "cette", "ces", "mes", "ton", "ta", "tes",
        "son", "sa", "ses", "notre", "nos", "votre", "vos", "leur", "leurs", "i", "he", "she", "it", "we", "they", "its",
        "that", "this", "these", "those", "there", "your", "his", "her", "our", "their",
    ]
    /// Right after the name (no comma), these make Jarvis the subject: "Jarvis est lent", "Jarvis m'a dit".
    private static let aboutVerbs: Set<String> = [
        "est", "etait", "sera", "serait", "a", "avait", "aura", "fait", "peut", "doit", "sait", "marche", "fonctionne",
        "plante", "bug", "bugue", "beugue", "repond", "comprend", "nest", "na", "ne", "me", "m", "te", "t", "lui",
        "is", "was", "has", "isnt", "doesnt", "cant", "wont", "works", "said", "says", "keeps",
    ]
    private static let spellings: Set<String> = [
        "jarvis", "jarvice", "jervis", "jarviss", "jarvisse", "javis", "jarvi", "djarvis", "charvis", "harvis", "garvis",
        "jarvise", "jarvy", "jarvie", "jarviz", "jarvish", "jarmi", "jarmy", "chervis", "shervis", "sharvis",
    ]

    static func normalize(_ word: String) -> String {
        word.folding(options: [.diacriticInsensitive, .caseInsensitive], locale: .init(identifier: "fr_FR"))
            .filter { $0.isLetter }
    }

    /// "Dis-moi" → ["dis", "moi"], "J'ai" → ["j", "ai"].
    private static func parts(_ word: String) -> [String] {
        word.split(whereSeparator: { "'’-".contains($0) }).map { normalize(String($0)) }.filter { !$0.isEmpty }
    }

    static func isName(_ word: String) -> Bool {
        let w = normalize(word)
        return spellings.contains(w) || (w.count >= 5 && w.count <= 7 && distance(w, "jarvis") <= 1)
    }

    private static let edge = CharacterSet(charactersIn: " ,.;:!?-–—…\"'«»").union(.whitespaces)

    /// Words, with a name the recogniser cut in two ("Jar vis") put back together.
    private static func words(_ text: String) -> [String] {
        var ws = text.split(whereSeparator: { $0.isWhitespace }).map(String.init)
        if !ws.contains(where: isName), ws.count > 1 {
            for i in 0..<(ws.count - 1) where isName(ws[i] + ws[i + 1]) && normalize(ws[i]).count >= 2 {
                ws.replaceSubrange(i...(i + 1), with: [ws[i] + ws[i + 1]])
                break
            }
        }
        return ws
    }

    private enum LeadIn { case greeting, short, no }

    /// Only greetings and fillers before the name, or a short lead-in that is not a sentence.
    private static func leadIn(_ before: [String]) -> LeadIn {
        var ws = before.flatMap(parts)
        for phrase in leadPhrases.sorted(by: { $0.count > $1.count }) {
            var i = 0
            while i + phrase.count <= ws.count {
                if Array(ws[i..<(i + phrase.count)]) == phrase { ws.removeSubrange(i..<(i + phrase.count)) } else { i += 1 }
            }
        }
        if ws.allSatisfy(lead.contains) { return .greeting }
        let unknown = ws.filter { !lead.contains($0) }
        // "Mon cher Jarvis" is a greeting; "mon projet Jarvis" is not.
        let possessive = ws.contains { $0 == "mon" || $0 == "ma" || $0 == "my" }
        let sentence = ws.contains { mention.contains($0) || statement.contains($0) }
        return unknown.count <= 2 && !possessive && !sentence ? .short : .no
    }

    static func match(_ text: String) -> Match {
        let words = words(text)
        guard let i = words.firstIndex(where: isName) else { return .none }
        let before = Array(words[..<i]), after = Array(words[(i + 1)...])
        let prev = before.last.flatMap { parts($0).last }
        let clean = { (ws: [String]) in ws.joined(separator: " ").trimmingCharacters(in: edge) }
        let hasWords = { (s: String) in s.contains(where: { $0.isLetter }) }

        // "Jarvis est lent", "Jarvis m'a dit…": Jarvis is the subject, nobody is talking to him.
        let setApart = words[i].last.map { ",.!?:;…".contains($0) } ?? false
        if !setApart, let next = after.first.flatMap({ parts($0).first }), aboutVerbs.contains(next) { return .none }

        // 1. Name opening the sentence, after a greeting or a short lead-in: "Bon, Jarvis, ouvre Teams".
        let opening = leadIn(before), rest = clean(after)
        if opening == .greeting { return hasWords(rest) ? .command(rest) : .alone }
        // A real word in the lead-in may belong to the request ("Ouvre, Jarvis, le terminal").
        if opening == .short, hasWords(rest) { return .command(clean(before.filter { !lead.contains(normalize($0)) } + after)) }
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
