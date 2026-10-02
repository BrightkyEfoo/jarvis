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

        check(Wording.fr(#"Click button "Comment" on github.com"#) == "Cliquer sur « Comment » (button) sur github.com", "browser click",
              Wording.fr(#"Click button "Comment" on github.com"#))
        check(Wording.fr(#"Click Button "Envoyer" in WhatsApp"#) == "Cliquer sur « Envoyer » dans WhatsApp", "screen click")
        check(Wording.fr(#"Type "LGTM" into textarea "Add a comment" on github.com"#) == "Taper « LGTM » dans « Add a comment » sur github.com", "fill")
        check(Wording.fr("Press cmd+q in Word") == "Appuyer sur cmd+q dans Word", "key")
        check(Wording.fr("Open https://x.cm in Arc") == "Ouvrir https://x.cm dans Arc", "browser open")

        // Neural voices: text prepared for reading, intelligibility metric.
        check(SpokenText.prepare("**Brightky**, 15 % de `remise`", lang: "fr") == "Braïtki, 15 pour cent de remise", "spoken fr",
              SpokenText.prepare("**Brightky**, 15 % de `remise`", lang: "fr"))
        check(SpokenText.prepare("Hi Brightky & team", lang: "en") == "Hi Bright-key and team", "spoken en")
        check(WordErrorRate.of(reference: "Tu as trois mails urgents.", hypothesis: "tu as trois mails urgents") == 0, "wer ignores case/punctuation")
        check(abs(WordErrorRate.of(reference: "un deux trois quatre", hypothesis: "un deux quatre") - 0.25) < 1e-9, "wer deletion")
        check(WordErrorRate.of(reference: "l’équipe produit", hypothesis: "l'équipe produit") == 0, "wer apostrophes")

        check(Wording.fr("Comment on forge acme/app#7: LGTM") == "Commenter acme/app#7 : LGTM", "forge comment fr", Wording.fr("Comment on forge acme/app#7: LGTM"))
        check(Wording.fr("Move Trello card 5f0000000000000000000003 to list 5f0000000000000000000009") == "Déplacer la carte Trello", "trello move fr")
        check(Wording.fr("Read PR acme/app#7") == "Lire la PR acme/app#7", "read pr fr")
        check(Wording.fr("Take up to 5 Trello cards labelled jarvis: one worker each, card → En cours, then PR link + card → À relire")
                == "Prendre jusqu'à 5 cartes Trello « jarvis » : un worker par carte, carte en cours puis lien de la PR et carte à relire", "trello take fr")
        check(Wording.fr("Start a worker on acme/app: Ajoute le mode sombre") == "Lancer un worker sur acme/app : Ajoute le mode sombre", "worker fr")

        // Hands-free: the name must come first (after an optional "hey/ok/dis").
        check(WakeWord.match("Jarvis, ouvre VS Code sur CodeVault.") == .command("ouvre VS Code sur CodeVault"), "wake + command")
        check(WakeWord.match("Hey Jarvis") == .alone, "wake alone")
        check(WakeWord.match("Ok Jervis quelle heure est-il ?") == .command("quelle heure est-il"), "close spelling", "\(WakeWord.match("Ok Jervis quelle heure est-il ?"))")
        check(WakeWord.match("Dis Jarvis. Stop.") == .command("Stop"), "short command")
        check(WakeWord.match("J'ai parlé à Jarvis hier") == .none, "mention is not a command")
        check(WakeWord.match("Jardin fleuri ce matin") == .none, "jardin is not Jarvis")
        check(WakeWord.match("Travis est en retard") == .none, "Travis is not Jarvis")
        check(WakeWord.match("") == .none, "empty")

        // Computer control guard, independent of the daemon.
        for url in ["https://www.paypal.com/x", "https://ebanking.ecobank.com", "https://www.afrilandfirstbank.com", "https://github.com/settings/tokens",
                    "https://accounts.google.com/"] {
            check((try? ActGuard.check(url: url)) == nil, "app refuses \(url)")
        }
        for url in ["https://github.com/acme", "https://mail.google.com/"] {
            check((try? ActGuard.check(url: url)) != nil, "app allows \(url)")
        }
        check(ActGuard.isSecure(role: "AXTextField", subrole: "AXSecureTextField", label: ""), "secure subrole")
        check(ActGuard.isSecure(role: "AXTextField", subrole: nil, label: "Mot de passe"), "password label")
        check(!ActGuard.isSecure(role: "AXButton", subrole: nil, label: "Mot de passe oublié ?"), "button is not a field")
        check(Osa.explain("execution error: Not authorized to send Apple events to Arc. (-1743)").contains("Automatisation"), "TCC hint")
        check(Osa.explain("execution error: Error: the tab was closed: read the page again (-2700)") == "the tab was closed: read the page again",
              "JS error unwrapped", Osa.explain("execution error: Error: the tab was closed: read the page again (-2700)"))

        print(failures == 0 ? "✔ \(passed) voice tests passed" : "✖ \(failures) failed, \(passed) passed")
        exit(failures == 0 ? 0 : 1)
    }
}
