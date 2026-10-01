import Foundation

/// Spoken answers to "Tu confirmes ?" — strict on purpose: anything unclear is not a yes.
enum Confirmation: Equatable {
    case yes, no, unclear

    private static let yesWords = ["oui", "ouais", "yes", "yep", "yeah", "confirme", "confirmé", "je confirme", "vas-y", "vas y",
                              "envoie", "envoie-le", "valide", "d'accord", "ok", "okay", "go", "go ahead", "confirm", "send it"]
    private static let noWords = ["non", "no", "nope", "annule", "annuler", "refuse", "stop", "attends", "pas maintenant", "cancel", "don't", "do not"]

    static func parse(_ transcript: String) -> Confirmation {
        let t = transcript.lowercased()
            .folding(options: .diacriticInsensitive, locale: Locale(identifier: "fr_FR"))
            .replacingOccurrences(of: #"[^\p{L}\p{N}' -]"#, with: " ", options: .regularExpression)
            .replacingOccurrences(of: #"\s+"#, with: " ", options: .regularExpression)
            .trimmingCharacters(in: .whitespaces)
        func starts(_ list: [String]) -> Bool {
            list.contains { w in
                let f = w.folding(options: .diacriticInsensitive, locale: Locale(identifier: "fr_FR"))
                return t == f || t.hasPrefix(f + " ")
            }
        }
        // "non, envoie pas" starts with no: the first word decides, a no always wins over a yes.
        if starts(noWords) { return .no }
        if starts(yesWords) { return .yes }
        return .unclear
    }

    /// Tool summaries are written in English for the audit log; this makes them speakable in French.
    static func spoken(_ summary: String, lang: String) -> String {
        guard lang == "fr" else { return summary }
        let rules: [(String, String)] = [
            (#"^Send from (\S+) to (\S+) — "([^"]*)":"#, "Envoyer depuis $1 à $2, objet « $3 » :"),
            (#"^Send to (\S+) — "([^"]*)":"#, "Envoyer à $1, objet « $2 » :"),
            (#"^Send draft (\S+) from (\S+)"#, "Envoyer le brouillon $1 depuis $2"),
            (#"^Open (.+) on (.+)$"#, "Ouvrir $1 sur $2"),
            (#"^Open "#, "Ouvrir "),
            (#"^Run: "#, "Exécuter : "),
            (#"^Move to Trash: "#, "Mettre à la corbeille : "),
            (#"^Remember \[(\w+)\]: "#, "Retenir : "),
            (#"^Run shortcut "#, "Lancer le raccourci "),
            (#"\(content not verified by Jarvis\)"#, "(contenu non vérifié par Jarvis)"),
        ]
        var s = summary
        for (pattern, template) in rules {
            s = s.replacingOccurrences(of: pattern, with: template, options: .regularExpression)
        }
        return s
    }
}
