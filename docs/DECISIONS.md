# Décisions d'architecture (ADR)

Format : contexte → décision → conséquences. Une ADR n'est jamais réécrite : elle est remplacée
par une nouvelle qui la cite. Versions vérifiées le 30/09/2026.

---

## ADR-001 — Monorepo pnpm, Node 24 LTS, TypeScript 7, sans build

**Contexte.** Consigne : performance maximale, technos « top du top », mais un daemon qui tourne
24 h/24 sur le Mac de Brightky.

**Décision.**
- **Node 24.21 LTS**. Le type stripping natif est stable depuis la 24.12, donc le code TypeScript
  s'exécute tel quel, sans étape de build.
- **Bun écarté** pour le daemon : sa stabilité en process long sous launchd n'est pas démontrée, et
  l'avance de `bun:sqlite` repose sur des benchmarks contestés.
- **pnpm 12.8** (réécrit en Rust). Les builds natifs sont autorisés explicitement (`allowBuilds`)
  et `minimumReleaseAge` est actif, contre les attaques de la chaîne d'approvisionnement.
- **TypeScript 7.0** (compilateur natif Go), avec `erasableSyntaxOnly` pour rester compatible avec
  le type stripping.
- **Biome 2.5** pour le lint et le format, **Vitest 5** pour les tests et les budgets de perf.

**Conséquences.** Pas d'`enum`, pas de `namespace`, pas de propriétés de paramètres. Les imports
portent l'extension `.ts`. Le lanceur `bin/jarvis` choisit le Node épinglé dans `.nvmrc`, car le
Node par défaut de la machine est la 22.

## ADR-002 — Cerveau : Claude Agent SDK sur l'abonnement, durci

**Contexte.** Brightky ne veut rien payer en dehors de son abonnement Max 5x, et veut un bon modèle
(pas Haiku). L'API Messages brute exige une clé API facturée. Le SDK, lui, lance le binaire Claude
Code, qui accepte le token d'abonnement (`claude setup-token`).

**Décision.**
- **Modèle et session** : Agent SDK 0.3.285 ; modèle `claude-sonnet-5-5` (effort `medium`) pour la
  conversation, `claude-opus-5-5` pour la planification (S2).
- **Session chaude** : une seule session longue en streaming input. `startup()` est lancé au
  démarrage du daemon, pour éviter un démarrage à froid à chaque phrase (mesuré : 1,2 à 3,1 s).
- **Isolation** :
  - `settingSources: []`, `strictMcpConfig`, `tools: []` (aucun outil intégré) ;
  - `CLAUDE_CONFIG_DIR` dédié : rien de `~/.claude` ne fuit ;
  - `persistSession: false`.
- **Contrôle** : `permissionMode: dontAsk` + `permissionPrompts: none`, un hook `PreToolUse` sur
  tous les outils, et **pas de `canUseTool`** (le SDK ne l'appelle jamais dans ce mode).
- **Vérification au runtime** : à chaque message `init`, la liste des outils et des serveurs MCP est
  contrôlée. Tout outil étranger déclenche STOP.

**Vérifié en réel (token factice, 0 quota).** Le modèle voit exactement les 7 outils
`mcp__jarvis__*`, un seul serveur MCP (`jarvis`, source `sdk`), et `apiKeySource: none`.

**Risque résiduel.** Les conditions d'Anthropic visent les produits offerts à des tiers et parlent
d'« usage individuel ordinaire » du SDK. L'usage perso semble couvert, mais ce n'est pas écrit
explicitement. Un adaptateur d'auth permettrait de basculer sur une clé API par simple config.

**Alternatives écartées.**
- Boucle maison sur l'API Messages : la plus rapide, mais facturée à la clé API.
- Agent SDK + clé API : même objection de coût.

## ADR-003 — Gate structurel, deny by default, aucun shell

**Décision.**
- **Gate** : tout outil est déclaré par `defineTool()` et n'existe qu'à travers `Gate.invoke()`,
  dans cet ordre : STOP → validation zod stricte → classification sur les arguments réels →
  `PolicyEngine` → approbation → audit → exécution → rédaction → audit.
- **Pas de shell** : les commandes sont parsées en AST et exécutées en argv via `spawn`, sans
  `sh -c`.
- **Pipes** : ce sont des pipes noyau directs entre process. Node ne relaie pas les données, ce qui
  préserve la vraie sémantique SIGPIPE.
- **Refus systématique** : expansions, globs, substitutions, sous-shells, assignations d'env,
  heredocs, et redirections posées sur une liste.

**Conséquences.** Le modèle ne dispose que d'un sous-ensemble de bash. C'est voulu : tout ce qui
demande l'interprétation d'un vrai shell est refusé plutôt que deviné.

## ADR-004 — Scellement de policy.yaml

**Décision.**
- La policy scellée vit dans **`/Library/Application Support/Jarvis/policy.yaml`**, un fichier
  `root:wheel 444` **dans un dossier `root:wheel 755`**.
- Un fichier root placé dans un dossier utilisateur pourrait être renommé puis remplacé : le dossier
  appartient donc lui aussi à root.
- Le SHA-256 est enregistré dans le Trousseau. Le daemon refuse de démarrer si le propriétaire, les
  droits ou le hash ne correspondent pas.
- La denylist N4 est **dans le code** : la policy peut seulement ajouter des refus et accorder N0 à
  N3.

**Outils.** `ops/scripts/seal-policy.sh`, à lancer par Brightky sous son propre utilisateur ; seule
la copie passe par sudo.

## ADR-005 — Audit append-only avec chaîne de hash

**Décision.**
- SQLite en WAL avec **`synchronous=FULL`**, parce que les coupures de courant sont fréquentes à
  Douala.
- Des triggers refusent `UPDATE` et `DELETE`.
- Chaque ligne porte le SHA-256 de la précédente ; `jarvis audit verify` détecte une modification ou
  une suppression faite en contournant les triggers.
- Un miroir `audit.jsonl` est tenu en parallèle.

**Mesuré.** Gate complet avec 2 écritures d'audit durables : **p99 680 µs** (budget 2 ms).

## ADR-006 — Secrets : Trousseau et rédaction

**Décision.**
- `@napi-rs/keyring` 2.1. `keytar` est archivé, et `security -w` exposerait le secret dans `ps`.
- Les secrets sont lus uniquement dans le code qui en a besoin, jamais dans le contexte du modèle.
- Un `Redactor` filtre toute sortie d'outil avant le modèle et avant l'audit : valeurs connues
  d'abord, puis motifs de tokens. Il ne re-masque pas un marqueur déjà posé.

## ADR-007 — IPC : Unix socket NDJSON

**Décision.**
- Socket `run/jarvisd.sock` : fichier en 0600, dossier en 0700, umask 077 pour tout le daemon.
- Les requêtes sont validées par un schéma zod strict.
- Le schéma est séparé des types, pour que la CLI ne charge pas zod.

**Mesuré.** Aller-retour **p99 29 µs** (budget 5 ms) ; démarrage du daemon **34 à 40 ms** (budget
300 ms).

## ADR-008 — Kill switch

**Décision.** Le flag STOP est persistant, sur disque et en mémoire, et survit à un redémarrage.
Son déclenchement :
1. refuse immédiatement tout appel d'outil, y compris dans le hook SDK (`continue: false`) ;
2. annule les approbations en attente ;
3. appelle `interrupt()` puis `close()` sur le process modèle ;
4. envoie SIGINT, puis SIGTERM, puis SIGKILL **au groupe de process**.

La reprise exige le PIN.

**Mesuré.** `sleep 30` est tué en moins de 500 ms.

## ADR-009 — Provenance et taint

**Décision.**
- La session est teintée dès qu'un outil `ingestsExternal` (fichier, sortie de commande, et plus
  tard mail, web, WhatsApp) a renvoyé du contenu.
- Une session teintée entraîne :
  - N3 refusé ;
  - aucune auto-approbation N2 ;
  - un signalement des destinations trouvées dans le contenu externe.
- Le contenu externe est encadré par `<external_data>`, et les fausses balises de fermeture sont
  neutralisées.

**Conséquences.** C'est volontairement grossier : après avoir lu un fichier, un N3 impose
`jarvis new`. Le lecteur en quarantaine (sous-agent sans outils N2+) arrive avec les intégrations
externes, au S4 et au S5.

## ADR-010 — Zéro coût hors abonnement

**Décision.**
- Token OAuth d'abonnement.
- `ANTHROPIC_API_KEY` et `ANTHROPIC_AUTH_TOKEN` sont **absents par construction** de
  l'environnement du sous-process.
- Au démarrage puis à chaque tour, le daemon refuse toute source facturée à l'API.
- Tout **overage payant** (`isUsingOverage`) déclenche STOP.
- `maxBudgetUsd` sert uniquement de garde anti-boucle.

**Conséquences pour la suite.**
- Twilio est payant : au S9, on étudie la passerelle SMS/GSM Raspberry Pi et Telegram.
- ElevenLabs est payant : TTS local (voir ADR-011).
- La recherche web passe par l'outil WebSearch du SDK, seulement en quarantaine.
- La CI tourne sur Linux (quota gratuit).

## ADR-011 — Chaîne vocale (décidée maintenant, implémentée au S3 et au S11)

**Décision.**
- Sidecar **Pipecat 1.12**, Python 3.12 via uv.
- Wake word **livekit-wakeword**, avec un modèle « Hey Jarvis » entraîné par nous.
- **Silero VAD 6.2** + **Smart Turn v3.2** (fin de tour sémantique, français).
- STT **Parakeet TDT 0.6B v3** via parakeet-mlx (FR WER 5,15 %), avec en secours Voxtral Mini
  Realtime.
- TTS **Kyutai Pocket TTS** (français natif, local, environ 200 ms), avec `say` en secours.
- AEC macOS Voice Processing I/O pour le barge-in.
- Le sidecar ne fait **que** de l'audio : le LLM et les outils restent dans jarvisd.

**Écartés.**
- openWakeWord : bug ONNX sur Apple Silicon (#336).
- Porcupine : fin de l'offre gratuite.
- Whisper MLX : non maintenu.
- ElevenLabs : payant.

**Budget.** Environ 0,7 s de latence hors LLM, environ 3 Go de RAM.

## ADR-012 — Langues

**Décision.** Code, commentaires et identifiants en anglais ; interface, voix et documentation
destinée à Brightky en français.

## ADR-013 — Deux parseurs shell

**Contexte.** Mesures faites sur le M1 Pro :

| Parseur | Médiane | p99 |
|---|---|---|
| tree-sitter-bash natif | 29 µs | 118 µs |
| sh-syntax (mvdan/sh en WASM) | 1 ms | 2,4 ms |

**Décision.**
- Sur le chemin critique (classification, qui doit rester sous 1 ms), **tree-sitter**, avec une
  liste blanche stricte des types de nœuds ; un arbre `hasError` est refusé.
- **sh-syntax** sert de contre-vérification juste avant l'exécution de `shell_run`, où 1 ms est
  négligeable devant un `spawn`. Les deux parseurs doivent accepter la commande.

**Mesuré.** `evaluate` (parse + classify + engine) : **p99 339 µs**.

## ADR-014 — Bilingue français / anglais (remplace l'ADR-012 pour la conversation)

**Contexte.** Brightky veut parler à Jarvis en français **et** en anglais (§9.10).

**Décision.**
- Jarvis répond dans la langue du dernier message ; si Brightky mélange, c'est la langue dominante
  qui compte. La règle est dans le prompt système.
- Le routeur de modèles reconnaît les intentions dans les deux langues.
- Voix (S3) : Parakeet v3 détecte la langue automatiquement, et Pocket TTS dispose de voix
  françaises et anglaises. La voix de sortie suivra la langue de la réponse.
- Le code reste en anglais. Les messages de la CLI restent en français ; leur traduction n'a pas
  été demandée.

## ADR-015 — Mémoire v1 : deux niveaux de confiance

**Décision.**
- **Notes Markdown** dans `~/Jarvis/memory/*.md`, écrites par Brightky. Elles sont fiables, lues
  au début de chaque session, et **jamais écrites par Jarvis**. Les outils fichiers génériques n'y
  ont pas accès (le dossier est ajouté à la denylist au démarrage).
- **Faits en SQLite** (FTS5, sans accents), écrits via `memory_remember`. Chaque fait porte sa
  provenance : `jarvis` en session propre, `external` si la session est teintée. Dans ce second
  cas, l'écriture passe en N2.
- **Les faits `external` n'entrent jamais dans le prompt système.** Ils ne sont accessibles que
  par `memory_search`, encadrés en `<external_data>`, et ils re-teintent la session. Une injection
  ne peut donc pas devenir permanente.
- Le snapshot de mémoire est placé après `SYSTEM_PROMPT_DYNAMIC_BOUNDARY` : le préfixe statique
  reste cacheable d'une session à l'autre.
- Oublier un fait l'archive (suppression douce).

**Mesuré.** Pour 500 faits, recherche p99 **345 µs** et snapshot p99 278 µs. Au départ, la
recherche prenait 884 µs parce que la requête était re-préparée à chaque appel ; les statements
sont désormais préparés une seule fois.

## ADR-016 — Routeur de modèles local, sans Haiku

**Décision.**
- Le routage est **local et instantané**, sans appel au modèle, à partir d'expressions françaises
  et anglaises : Sonnet 5.5 par défaut, Opus 5.5 pour planifier, concevoir, comparer ou réfléchir
  en profondeur.
- L'utilisateur peut forcer le choix : « opus » pour Opus ; « vite », « rapide » ou « quick » pour
  Sonnet.
- Si le quota Opus hebdomadaire est à 90 % ou plus, ou épuisé, la demande part sur Sonnet et la
  raison est affichée.
- La bascule se fait par `setModel()` sur la session chaude. **Un échec de bascule n'est pas
  fatal** : le tour continue sur le modèle courant et l'échec est journalisé. Ce cas a été trouvé
  avec le vrai SDK.
- Changer de modèle invalide le cache de prompt (propre à chaque modèle). C'est accepté, car les
  demandes de planification sont rares.

## ADR-017 — Outils macOS et compteur de coûts

**Décision.**
- **Outils** :
  - `projects_list` et `app_open` couvrent « ouvre VS Code sur le projet X ». Les projets viennent
    de `projects.roots` et `projects.paths`, qui doivent être dans les `read_roots`.
  - Apps autorisées : N1. Autres apps : N2. **Apps qui exécutent des documents** (Terminal, iTerm,
    Script Editor, Automator, Installer, Réglages…) : N3 seules, N4 avec un document.
  - `url_open` : http(s) seulement, en N1. Tout autre schéma est N4. Un lien trouvé dans du
    contenu externe passe en N2 (risque d'exfiltration par la query string).
  - `shortcut_run` : niveau fixé par la politique, N3 si le raccourci n'y figure pas. **Tout
    raccourci dont le nom évoque de l'argent** (money, paiement, virement, banque, momo…) est **N4
    codé en dur** : paiements hors périmètre.
  - `apps_running` (JXA/NSWorkspace, sans permission TCC, environ 140 ms), `shortcuts_list` et
    `system_status` (batterie ou secteur, uptime, disque) : N0.
  - Les effets de bord passent par l'interface `MacOps`, injectée : les tests ne lancent jamais
    d'application.
- **Coûts** :
  - Le SDK rapporte des totaux **cumulés** sur une session longue ; le coût d'un tour est la
    différence avec le tour précédent. Le code du S0 affichait donc un coût faux dès le deuxième
    tour ; c'est corrigé.
  - Chaque tour est enregistré (modèle, route, tokens, tokens en cache, coût équivalent API, TTFT).
  - La CLI affiche un pied de page à chaque requête, `jarvis costs [today|week|month]` donne les
    agrégats, et le quota de l'abonnement s'affiche par fenêtre.
  - Coût réellement facturé : 0 €, puisque tout passe par l'abonnement.

## ADR-018 — Voix native Apple, 0 Mo (remplace l'ADR-011 pour le S3)

**Contexte.** La pile de l'ADR-011 (Pipecat, Parakeet, Pocket TTS…) demandait environ **2 Go de
téléchargement**. Brightky n'a pas cette data aujourd'hui, et la consigne reste : zéro coût hors
abonnement, performance maximale.

**Décision.** Une app native Swift, `Jarvis Voice.app` (228 Ko, compilée sur la machine), qui
n'utilise que ce que macOS fournit déjà :
- **Reconnaissance** : `SFSpeechRecognizer` avec `requiresOnDeviceRecognition`. Aucun son ne
  quitte le Mac, aucune data n'est consommée.
  - Deux reconnaisseurs, `fr-FR` et `en-US`, écoutent le même audio en parallèle. La lecture
    retenue combine la confiance du reconnaisseur et la probabilité de langue calculée par
    NaturalLanguage.
  - Le reconnaisseur de la mauvaise langue renvoie « No speech detected », ce qui donne une
    détection de langue gratuite.
- **Push-to-talk** : un hot key Carbon (⌥Espace, réglable) signale l'appui et le relâchement,
  sans permission Accessibilité. La fin de tour est exacte, sans attente de VAD.
  Le VAD et le wake word arrivent avec le mode mains libres (S11).
- **Voix** : `AVSpeechSynthesizer` avec les voix installées. Thomas (FR) et Daniel (EN,
  britannique) par défaut. Si une variante Améliorée ou Premium est téléchargée plus tard en
  Wi-Fi, elle est choisie automatiquement.
  - La réponse est lue **phrase par phrase pendant le streaming** ; le markdown, le code, les
    liens et les emojis sont retirés.
  - La langue de la voix suit chaque phrase.
- **Barge-in** : réappuyer sur le raccourci coupe la voix et envoie `interrupt` au daemon. Cela
  abandonne le tour en cours sans STOP ; un garde-fou réinitialise le process modèle au bout de
  3 s.
- **Style oral** : les tours vocaux sont préfixés `[voix]`. Le prompt système demande alors 1 à 3
  phrases, sans markdown. Le préfixe est porté par le message, ce qui préserve le cache.
- **Préchauffage** : les deux modèles locaux sont chargés au lancement. Le tout premier essai en
  français avait échoué à froid.
- **Identité** : l'app est lancée via LaunchServices (`jarvis voice`), donc les permissions Micro
  et Reconnaissance vocale lui sont attribuées à elle, et ses logs reviennent dans le terminal.

**Mesuré (autotest sur fichiers, M1 Pro).**

| Mesure | Résultat |
|---|---|
| Reconnaissance EN | 242 ms, confiance 0,98 |
| Reconnaissance FR | 872 ms pour un fichier entier |
| Premier son de la voix | 45 à 49 ms |

En direct, la reconnaissance se fait pendant que Brightky parle : au relâchement, il ne reste que
la finalisation.

**Chemin d'évolution.** Le moteur est interchangeable (`Listener` / `Speaker`). Parakeet v3 et
Pocket TTS (ADR-011) pourront le remplacer quand la data le permettra, si la qualité française
l'exige.

**Limites connues.**
- Les noms propres sont mal reconnus (« CodeVault » entendu « GO ») ; un vocabulaire
  personnalisé (`contextualStrings`) peut corriger ça.
- Les voix compactes restent un peu robotiques.
- La signature est ad hoc : **chaque recompilation fait redemander les permissions**. Un
  certificat local de signature stable est prévu avec le HUD (S8).

## ADR-019 — Mail et agenda : REST direct, IMAP, lecteur en quarantaine

**Décision.**
- **Google** : appels REST directs (`fetch`) pour Gmail et Agenda.
  - On n'utilise **pas** le SDK `googleapis`, qui est énorme : la data est limitée.
  - OAuth « Desktop app » avec **PKCE** sur une boucle locale ; le refresh token va dans le
    Trousseau, et l'access token reste en mémoire.
  - Scopes : `gmail.readonly`, `gmail.compose` et `calendar.readonly`. Comme `compose` inclut
    l'envoi, **l'envoi est bloqué par le gate (N2)**.
- **IMAP / SMTP** : `imapflow`, `nodemailer` et `mailparser`, soit quelques Mo.
  - TLS est obligatoire (implicite, ou STARTTLS requis).
  - Un certificat auto-signé est accepté par `ca_pem`, **sans jamais désactiver la vérification**.
  - Les brouillons sont gardés tels que construits : on envoie **exactement les octets
    approuvés**. Ils sont aussi copiés dans le dossier Brouillons du serveur.
- **Lecteur en quarantaine** (§3.4) :
  - Chaque lecture de mail passe par une requête séparée **sans aucun outil**, avec
    `outputFormat` JSON Schema et un hook qui refuse tout outil.
  - La sortie est validée par zod. Les ids inventés sont ignorés, les champs sont tronqués, et
    l'expéditeur, le sujet et la date viennent du **serveur**, jamais du modèle.
  - Une injection détectée force la catégorie `suspicious`.
  - Si la quarantaine échoue, on retombe sur un résumé par métadonnées.
- **Envoi** :
  - `mail_draft` est N1 (rien ne part).
  - `mail_send` est N2. Il se base sur l'empreinte du brouillon écrit par Jarvis : si le
    brouillon a changé depuis l'approbation, **rien n'est envoyé**.
  - L'approbation montre le destinataire, l'objet et le début du corps.
- **Briefing** : un seul outil qui interroge l'agenda, les mails de tous les comptes (urgents
  d'abord) et l'état du Mac en parallèle. Un seul aller-retour modèle, donc moins de latence.
- **Comptes** : la liste des boîtes lisibles est dans la politique **scellée**. Une boîte en panne
  n'empêche pas le briefing, elle y est signalée.

## ADR-020 — Confirmations N2 à la voix, daemon sous launchd

**Décision.**
- **Voix** : à une demande N2, Jarvis lit le résumé en français, signale un destinataire issu d'un
  contenu externe, puis demande « Tu confirmes ? ».
  - Brightky maintient le raccourci et répond. Le oui doit être explicite (oui, je confirme,
    vas-y…), **un non l'emporte toujours**, et tout ce qui n'est pas clair n'est pas un oui. Au
    bout de 2 essais, la validation est renvoyée au terminal.
  - Le canal `voice` est enregistré dans l'audit.
  - **N3 jamais à la voix** : le serveur refuse `approve` sur ce canal pour une action qui demande
    le PIN, et le PIN ne se prononce jamais.
- **launchd** : `jarvis service install [--dev] [--voice]` installe des **LaunchAgents** (session
  utilisateur, pas root), avec ces réglages :
  - démarrage à la connexion, `KeepAlive`, `ProcessType=Interactive` ;
  - **Node 24 en chemin absolu** et `PATH` minimal, donc pas d'environnement hérité du shell (donc
    pas de `NODE_TLS_REJECT_UNAUTHORIZED`) ;
  - logs dans `~/Library/Logs/Jarvis`.

  Sans politique scellée, l'installation exige `--dev`.
- **Mac toujours disponible** : `ops/scripts/mac-always-on.sh` (pas de veille sur secteur,
  redémarrage après coupure si le matériel le permet). Un MacBook traverse les coupures de Douala
  grâce à sa batterie.

## ADR-021 — Recherche web et YouTube (avancées depuis le S13)

**Contexte.** Brightky veut que Jarvis fasse ses recherches, y compris « regarder » des vidéos
YouTube. Contraintes : data limitée, zéro coût hors abonnement.

**Décision.**
- **`web_research`** : un **agent de recherche isolé**, sous forme de requête SDK séparée.
  - Surface vérifiée en réel : `WebSearch` + `StructuredOutput`, rien d'autre (pas de fichiers,
    de mails, de shell ni d'outils Jarvis).
  - WebSearch s'exécute **côté Anthropic** : le Mac ne télécharge pas de pages et la recherche est
    incluse dans l'abonnement.
  - Un hook n'autorise que ces outils et plafonne WebFetch si un CLI futur l'expose.
  - La sortie est un JSON validé (réponse, points clés, sources en http(s) seulement, confiance,
    injection suspectée).
  - Le mode `quick` utilise Sonnet ; le mode `deep` utilise Opus avec un effort élevé.
- **`youtube_search` / `youtube_watch`** : yt-dlp installé avec `uv tool install --with yt-dlp-ejs
  yt-dlp`, environ 14 Mo, sans le Python 3.14 ni le Deno de Homebrew (plus de 100 Mo).
  - Node 24 sert de moteur JavaScript pour les défis YouTube.
  - **Seuls les sous-titres** sont téléchargés (`--skip-download`) : environ 50 à 100 Ko, plus la
    page.
  - L'URL est réduite à son **id de 11 caractères**, puis reconstruite par Jarvis : yt-dlp ne
    reçoit jamais d'URL arbitraire.
  - La transcription, en paragraphes horodatés de 30 s, est lue par l'agent en **mode document,
    sans aucun outil**.
- Les sorties sont des données externes : encadrées, et elles teintent la session.

**Bug trouvé en réel.** `z.toJSONSchema` produit un schéma au format draft 2020-12, que le CLI
refuse. La quarantaine des mails retombait **silencieusement** sur les métadonnées. Le schéma est
maintenant au format draft-07, sans l'en-tête `$schema`.

**Mesuré.** Sous-titres du TED « Inside the Mind of a Master Procrastinator » (14 min) : 6,7 s,
français choisi automatiquement, 13 400 caractères. Recherche YouTube : 1,9 s.

**Risque résiduel.** Une page web piégée peut biaiser une synthèse, sans jamais pouvoir agir.
Ouvrir une source citée passe par `url_open` (N2 en session teintée).

## ADR-022 — Tableau de bord natif SwiftUI (remplace Tauri pour le HUD, S8 avancé)

**Contexte.** Brightky veut un tableau de bord complet : voir chaque action, contrôler Jarvis, voir
les prévisions. Avec Tauri (ADR du plan), il aurait fallu compiler des centaines de Mo de crates
Rust, alors que la data est limitée.

**Décision.**
- Une seule app native **Jarvis.app** en SwiftUI (1,2 Mo, 0 Mo de téléchargement : SwiftUI et
  Swift Charts sont dans macOS).
- Elle regroupe :
  - l'icône de barre de menus, qui change selon l'état (écoute, réflexion, parole, validation
    attendue, STOP) ;
  - un panneau rapide : activité, validations N2 en un clic, quota, STOP ;
  - la fenêtre « tableau de bord » ;
  - la voix push-to-talk.
- Le **tableau de bord** compte 8 sections : vue d'ensemble, activité (journal filtrable, en
  direct), validations (avec PIN pour N3), coûts et quota (graphique sur 30 jours, détail par
  modèle), prévisions, mémoire, comptes et outils, réglages. La signature « fait avec ❤️ par
  Brightky Efo'o » est présente.
- **Daemon** :
  - `dashboard` renvoie un instantané ;
  - `watch` diffuse en direct les lignes d'audit, les validations, l'activité du cerveau, le quota
    et STOP/reprise ;
  - `audit_query` (historique) et `upcoming` (agenda) complètent l'API.
- **Prévisions** :
  - le quota est échantillonné à chaque `rate_limit_event`, et une tendance linéaire depuis la
    dernière réinitialisation donne « saturé vers 16:40 » ou « OK jusqu'à la réinitialisation » ;
  - on projette aussi le mois en équivalent API, et l'agenda à venir.
- **Sécurité** : le tableau de bord est un client du socket comme la CLI, sur le canal `hud`
  enregistré dans l'audit. Il ne débloque rien. Le PIN est accepté depuis le terminal et le
  tableau de bord, jamais depuis la voix.
- Les résumés d'actions (en anglais dans l'audit) sont traduits par une table commune
  (`Wording`) à la voix et à l'interface.
- **Vérification visuelle sans capture d'écran** : `--snapshot` dessine chaque section avec des
  données de démo, depuis la propre hiérarchie de vues de l'app.
- **Signature stable** : `apps/mac/signing-setup.sh` crée, une seule fois, une identité locale
  dans un trousseau dédié. Les autorisations Micro et Reconnaissance vocale survivent alors aux
  recompilations. Il faut le mot de passe de Brightky une fois, pour approuver le certificat.

## ADR-023 — Accès aux forges et identité (décisions de Brightky, 01/10/2026)

**Décisions de Brightky.**
- **Périmètre** : Jarvis accède à **tous** ses dépôts GitHub **et** GitLab (152 dépôts GitHub
  perso, plus les organisations `scriptify-cm` et `javascriptcm`), à **tous** les tableaux et
  **toutes** les cartes Trello.
- **PR** : Jarvis peut **ouvrir des PR sans demander** sur ses dépôts.
- **Identité** : il agit **sous le nom de Brightky**. Les commits sont faits avec son identité git,
  **sans `Co-Authored-By`** ni mention « Generated with Claude Code ». Hors de la machine,
  Jarvis est Brightky. Cela tranche aussi le §9.7 : pas de mention « réponse assistée ».

**Garde-fous maintenus dans le code**, non négociables :
- jamais de merge automatique ;
- jamais de push direct ou forcé sur `main`/`master` (N4) ;
- les workers tournent en worktree isolé, avec un hook de politique injecté ;
- token *fine-grained* sans droits d'administration ;
- commenter et déplacer une carte restent N2, sauf règle d'auto-approbation explicite.

**Pour les workers (S6)**, faits vérifiés dans la doc Claude Code :
- `--settings '{"attribution": …}'` désactive l'attribution ;
- un hook `PreToolUse` injecté via `--settings` s'applique dans tous les modes ;
- ne **pas** utiliser `--bare`, qui ignore le token d'abonnement ;
- `ANTHROPIC_API_KEY` doit être absent de l'environnement.

Le format exact de `attribution` sera vérifié sur le binaire réel avant usage.

## ADR-024 — Pilotage du Mac quand il n'y a pas d'API (01/10/2026)

**Demande de Brightky** : quand un token ou une API n'existe pas, Jarvis doit utiliser son
navigateur, ses notes et **toutes ses applications**, tranquillement.

**Ses choix** :
- navigateur : son **profil principal** (Arc, Chrome possible via `computer.browser`) ;
- actions qui engagent (Envoyer, Publier, Valider…) : **confirmées, sauf liste blanche** ;
  payer reste interdit ;
- priorité : le pilotage du Mac d'abord, avant les workers de code (S5–S7).

**Architecture**
- **Jarvis.app tient les mains**. Elle détient seule les autorisations macOS : Accessibilité,
  Enregistrement de l'écran et Automatisation. Elle se connecte au socket du daemon et s'enregistre
  comme *actionneur* (`actuator_register`). Le daemon lui envoie des actions déjà décidées
  (`actuate`) et attend `actuator_result`. Node n'obtient jamais ces autorisations : une permission
  TCC donnée à `node` vaudrait pour n'importe quel script Node.
- **Catalogue fixe**. L'app n'exécute jamais de source envoyée par le daemon. Elle exécute ses
  propres scripts JXA, via `osascript` lancé par l'app, donc attribué à Jarvis par TCC. Les
  valeurs (URL, texte, identifiants) passent **en argv** : rien de ce que dit une page ou une note
  ne peut devenir du code.
- **Trois familles d'outils** :
  - **navigateur** : `browser_tabs`, `browser_open`, `browser_read`, `browser_click`,
    `browser_fill`, `browser_back`. Ils passent par Apple Events et du JS injecté dans l'onglet,
    sur le profil connecté de Brightky ;
  - **Notes et Rappels** : `notes_*`, `reminders_*`. Apple Events, sans écran ;
  - **n'importe quelle app** : `screen_look` (capture ScreenCaptureKit de la fenêtre, avec
    l'arbre d'accessibilité numéroté) et `screen_act` (clic, frappe, touche, défilement par
    CGEvent).

**Règles** (`packages/policy/src/screen.ts`, listes intégrées au code et non relâchables)

| Cas | Niveau |
|---|---|
| Sites bancaires, de paiement, de gestion de mots de passe, de sécurité de compte (`accounts.google.com`, `github.com/settings`…) | N4 |
| Boutons de paiement (Payer, Acheter, Commander, Faire un don…) | N4 |
| Champs mot de passe, code à usage unique ou carte | N4 |
| Terminal et équivalents, Réglages Système, Trousseau, gestionnaires de mots de passe, Jarvis lui-même | N4 |
| Touches qui font sortir de l'app : ⌘Espace, ⌘Tab, ⌥⌘Échap, ⇧⌘Q… | N4 |
| Actions destructrices : Supprimer, Merge, Approuver, Fermer le ticket, ⌘Q, ⌘⌫… | N2, **même en liste blanche** |
| Actions qui engagent : Envoyer, Publier, Commenter, Réserver, Entrée dans une conversation… | N2, ou N1 sur un domaine ou une app de `commit_allow_*` |
| Clic simple, lecture | N1 / N0 |

**Le niveau vient de ce que l'élément est réellement, pas de ce que dit le modèle.**
- **Navigateur** : `browser_read` numérote les éléments et le daemon garde leur description. Le
  clic est classé d'après le libellé réel, et `commit: true`, déclaré par le modèle, ne peut
  qu'**élever** le niveau. Dans la page, une empreinte (origine, balise, libellé, href) est
  revérifiée juste avant le clic : si la page a changé, le clic est refusé.
- **Écran** : avant chaque clic ou frappe, une sonde d'accessibilité lit l'élément sous le
  pointeur. Si c'est un « Envoyer » non déclaré, l'action est refusée (`Refusal`, nouvelle
  primitive du gate) et le modèle doit redemander avec `commit: true`. Le libellé est revérifié
  entre la sonde et l'action.
- **Taint** : tout ce qui est affiché (page, capture, note, onglet) **teinte la session**.
- **Audit** : les captures vont au modèle (bloc image MCP) mais **jamais dans l'audit**, qui ne
  garde que leur empreinte SHA-256 et leur taille.

**Clavier** : les caractères passent par la disposition active (UCKeyTranslate). Sur un clavier
AZERTY, « cmd+a » ne devient jamais ⌘Q.

**Arrêt d'urgence** : **⌃⎋** (Ctrl + Échap), raccourci global de Jarvis.app. Il annule l'action
en cours dans l'app et déclenche STOP dans le daemon. STOP envoie aussi `actuate_cancel`, qui tue
l'`osascript` en cours. Pendant qu'il pilote, l'icône de la barre de menus passe en curseur et le
panneau affiche « Jarvis pilote … ».

**Défense en profondeur côté app** : même si le daemon se trompait ou était usurpé, Jarvis.app
refuse d'elle-même :
- les apps interdites (par identifiant de bundle) ;
- les sites bancaires et d'identité ;
- la frappe dans un champ sécurisé ;
- les touches système.

**Écartés**
- **Playwright / CDP** : il ne peut pas piloter le profil principal sans relancer le navigateur
  avec un port de debug, ce qui ouvre une porte à tout process local, et il pèse environ 13 Mo.
- **NSAppleScript en processus** : la source y serait interpolée et l'exécution difficile à tuer.
  `osascript` + argv est sûr et tuable, pour environ 60 ms de plus par action.

**Risque assumé** : sur un domaine en liste blanche, une page piégée pourrait pousser Jarvis à
cliquer « Commenter » sans confirmation. Les destructions et les paiements restent bloqués ou
confirmés. La liste blanche est vide par défaut ; Brightky la remplit en connaissance de cause.
