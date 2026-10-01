import Foundation

/// Minimal runner (no XCTest dependency): `./test.sh`.
@main
enum VoiceTests {
    static var failures = 0
    static var passed = 0

    static func check(_ ok: Bool, _ name: String, _ detail: @autoclosure () -> String = "") {
        if ok {
            passed += 1
        } else {
            failures += 1
            print("✖ \(name) \(detail())")
        }
    }

    static func chunks(_ pieces: [String]) -> [String] {
        var c = SpeechChunker()
        var out: [String] = []
        for p in pieces { out += c.push(p) }
        return out + c.flush()
    }

    static func main() {
        // Sentences come out as soon as they are complete, even when split across stream chunks.
        var c = SpeechChunker()
        check(c.push("Bonjour Brig") == [], "no sentence yet")
        check(c.push("htky. Il est 9 h") == ["Bonjour Brightky."], "first sentence emitted early", "\(c)")
        check(c.flush() == ["Il est 9 h"], "rest flushed at the end")

        check(chunks(["Version 3.5 ok. Suite"]) == ["Version 3.5 ok.", "Suite"], "decimals are not boundaries")
        check(chunks(["Quoi ? Oui ! Bien…", " fin"]) == ["Quoi ?", "Oui !", "Bien…", "fin"], "? ! … boundaries")

        let code = chunks(["Voici :\n```ts\nconst x = ", "1;\n```\nC'est tout."])
        check(code == ["Voici :", "(code omis).", "C'est tout."], "code blocks are not read", "\(code)")
        check(chunks(["Début ```js\nnever closed"]) == ["Début (code omis)."], "unclosed fence at the end")

        let long = String(repeating: "mot ", count: 60) + "fin, suite sans point"
        check(chunks([long]).allSatisfy { $0.count <= SpeechChunker.maxChunk }, "long text is cut")

        check(SpeechChunker.clean("**Gras** et `fs_read` — voir [la doc](https://x.y) https://evil.test/a 🎉")
                == "Gras et fs read — voir la doc", "markdown, links, emojis stripped",
              SpeechChunker.clean("**Gras** et `fs_read` — voir [la doc](https://x.y) https://evil.test/a 🎉"))
        check(SpeechChunker.clean("- premier point") == "premier point", "bullets stripped")
        check(SpeechChunker.clean("<external_data source=\"fs_read\">texte</external_data>") == "texte", "tags stripped")
        check(chunks(["🎉🎉.\n"]).isEmpty, "nothing speakable is dropped")

        // Language: the reading that makes sense wins; short fragments follow the conversation.
        let fr = Candidate(lang: "fr", text: "Ouvre VS Code sur le projet CodeVault", confidence: 0.82)
        let enGarbage = Candidate(lang: "en", text: "Of the ice code sure le project code vault", confidence: 0.41)
        check(LanguagePick.choose([fr, enGarbage], prefer: "en")?.lang == "fr", "French speech → French reading")
        let en = Candidate(lang: "en", text: "What is on my calendar today?", confidence: 0.9)
        let frGarbage = Candidate(lang: "fr", text: "Oiseau zone mail calendrier to dé", confidence: 0.35)
        check(LanguagePick.choose([frGarbage, en], prefer: "fr")?.lang == "en", "English speech → English reading")
        check(LanguagePick.choose([Candidate(lang: "fr", text: " ", confidence: 0)], prefer: "fr") == nil, "silence → nil")
        check(LanguagePick.replyLanguage("OK.", hint: "en") == "en", "short reply follows the hint")
        check(LanguagePick.replyLanguage("La réunion est décalée à jeudi matin.", hint: "en") == "fr", "French reply detected")
        check(LanguagePick.replyLanguage("The meeting was moved to Thursday morning.", hint: "fr") == "en", "English reply detected")

        // Spoken confirmations: strict yes, a no always wins, anything else is unclear.
        for t in ["Oui.", "oui, envoie", "Ouais", "Yes please", "Je confirme", "vas-y", "OK"] {
            check(Confirmation.parse(t) == .yes, "yes: \(t)")
        }
        for t in ["Non.", "non, oui en fait", "Annule", "no", "Stop", "attends"] {
            check(Confirmation.parse(t) == .no, "no: \(t)")
        }
        for t in ["", "euh", "peut-être", "c'est qui Paul ?", "ouistiti"] {
            check(Confirmation.parse(t) == .unclear, "unclear: \(t)")
        }
        check(Confirmation.spoken("Send from perso to paul@client.cm — \"Devis\": Je valide.", lang: "fr")
                == "Envoyer depuis perso à paul@client.cm, objet « Devis » : Je valide.", "summary spoken in French",
              Confirmation.spoken("Send from perso to paul@client.cm — \"Devis\": Je valide.", lang: "fr"))
        check(Confirmation.spoken("Run: uname -s", lang: "en") == "Run: uname -s", "English summary unchanged")
        check(Wording.fr("Draft (perso) to paul@client.cm — \"Devis\"") == "Brouillon (perso) pour paul@client.cm — « Devis »", "draft summary in French")
        check(Wording.fr("Open Visual Studio Code on ~/w/CodeVault") == "Ouvrir Visual Studio Code sur ~/w/CodeVault", "open on")
        check(Wording.fr("Read mail perso#m1") == "Lire le mail perso#m1", "read mail before read")
        check(Wording.fr("Triage mail all accounts (24 h)") == "Tri des mails : tous les comptes (24 h)", "triage", Wording.fr("Triage mail all accounts (24 h)"))

        print(failures == 0 ? "✔ \(passed) voice tests passed" : "✖ \(failures) failed, \(passed) passed")
        exit(failures == 0 ? 0 : 1)
    }
}
