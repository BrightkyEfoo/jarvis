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

## ADR-025 — Voix neuronales locales : Parakeet + PocketTTS sur CoreML (02/10/2026)

**Contexte.** L'ADR-018 avait choisi les voix et la reconnaissance d'Apple faute de data. Le
02/10, Brightky donne son feu vert au téléchargement (environ 2,5 Go annoncés) et demande
« de meilleures voix, majoritairement des hommes, en français et en anglais ».

**Décision.** La pile **FluidAudio 0.17.5** (Swift, CoreML, Apache 2.0, version épinglée),
intégrée dans Jarvis.app, qui devient un paquet Swift.
- **Reconnaissance** : **Parakeet TDT 0.6B v3**. Un seul passage reconnaît le français ou
  l'anglais, 100 % local. Mesuré : **94 à 133 ms** pour une phrase, contre 242 à 872 ms avec les
  deux reconnaisseurs Apple.
- **Synthèse** : **PocketTTS** (Kyutai, 100 M paramètres) en streaming, par trames de 80 ms.
  - **Anglais** (pack 6 couches) : 8 voix intégrées, dont 7 masculines. 2,8× plus rapide que le
    temps réel, **100 à 200 ms** au premier son à chaud, 0 % d'erreur de compréhension mesurée
    par Parakeet.
  - **Français** (pack 24 couches) : 4 voix masculines clonées, plus Estelle. **1,2× le temps
    réel** sur le M1 Pro (int8, GPU) et **0,6 à 1 s** au premier son. Le préremplissage du pack
    24 couches coûte environ 0,6 s par bloc : le lecteur regroupe donc les phrases en attente
    en un seul appel, avec des blocs de 100 jetons.
- **Bascule** : les voix Apple restent le secours. La pile neuronale se charge en arrière-plan
  et prend la main au premier moment calme. Sa compilation CoreML prend quelques minutes, une
  seule fois par machine.
- **Choix des voix** : dans le tableau de bord (Réglages › Voix), avec écoute des échantillons
  produits par `jarvis voice samples`.

**Consentement des voix clonées (non négociable).**
- Les conditions de PocketTTS interdisent de cloner une voix sans consentement explicite.
- Les extraits CML-TTS (lecteurs LibriVox, CC BY) ont été **écartés** : ces personnes n'ont pas
  consenti au clonage.
- Les 4 voix françaises viennent du **Kyutai Voice Donation Project** (voix données pour le
  clonage, CC0) et d'un enregistrement de l'équipe Kyutai.
- Origine et licences dans `apps/mac/Resources/voices/CREDITS.md`.

**Mesures qui ont tranché** (M1 Pro, sur batterie) :

| Option | Résultat | Verdict |
|---|---|---|
| Supertonic-3 (5 voix M, 31 langues) | 0,6–0,7× le temps réel | écarté (coupures) |
| PocketTTS FR, phrase par phrase | 0,6–0,8×, 1,4 s de préremplissage par phrase | remplacé par les blocs |
| PocketTTS FR, blocs de 100 jetons, GPU | 1,2×, premier son 0,6–1 s | **retenu** |
| PocketTTS FR, placement puce neuronale (rank-4) | 0,8×, premier son 1,4 s | écarté (modèles supprimés) |
| Kokoro FR | une seule voix, féminine | écarté |

**Téléchargement réel** (connexion mesurée entre 0,15 et 1,5 Mo/s) : seul le nécessaire.
- Pack français : modèles int8, voix Estelle et encodeur de clonage, soit environ 1 Go au lieu
  de 1,6 Go.
- Pack anglais : 530 Mo.
- Parakeet : 470 Mo.
- Les variantes inutilisées ne sont pas téléchargées.

**Écartés** : Voxtral TTS (4 B, licence non commerciale), Chatterbox (environ 1× sur M5 Pro, pas
de streaming), Qwen3-TTS et Kyutai TTS 1,6 B (trop lourds pour le M1 Pro avec les workers).

## ADR-026 — S5 : GitHub, GitLab et Trello (02/10/2026)

**Décision.** Trois clients REST en `fetch` natif, sans SDK, dans `packages/connectors/src/forge`.
- **Sécurité des identifiants**
  - Les tokens sont dans le Trousseau. Ils voyagent **uniquement dans des en-têtes** :
    `Authorization: Bearer` pour GitHub, `PRIVATE-TOKEN` pour GitLab, `OAuth` pour Trello.
    Jamais dans une URL, car les URL finissent dans les erreurs et les journaux.
  - Chaque appel a un délai d'expiration, refuse tout autre hôte que la base de l'API, et ses
    erreurs ne contiennent jamais le token.
- **Validation des entrées**
  - Les noms de dépôts sont validés sans segment `.` ni `..` : un test a révélé que `../../etc`
    passait la première version de l'expression régulière.
  - Les identifiants Trello sont validés eux aussi.
  - GitLab n'accepte que le https.
- **Boîte de réception** (`forge_inbox`)
  - **GitHub**, en 3 recherches : `review-requested:@me`, `author:@me`, `assignee:@me`. Pour ses
    propres PR (10 au plus), Jarvis ajoute l'état de la CI (check-runs) et des relectures (le
    dernier avis de chaque relecteur compte).
  - **GitLab** : endpoints globaux (`reviewer_username`, `created_by_me`, `assigned_to_me`),
    avec le pipeline et les approbations.
- **Diffs** : un budget de caractères (`forges.max_diff_chars`, 60 000 par défaut) est réparti
  des plus petits fichiers aux plus gros. Au-delà, le diff est tronqué ou remplacé par la liste
  des fichiers. Claude résume en mots simples.
- **Niveaux**
  - La lecture est N0. Elle teinte la session : une PR peut contenir une injection.
  - Commenter et déplacer une carte sont N2, avec auto-approbation possible par dépôt dans la
    politique, et jamais après un contenu externe (moteur existant).
- **Briefing** : une section « Code » avec ce qui attend relecture, ses PR en échec de CI ou
  avec changements demandés, et ses cartes Trello.
- **Connexion** : `jarvis github|gitlab|trello connect`. Saisie masquée, vérification « qui
  suis-je » avant l'enregistrement, avertissement si le token GitHub est classique (`ghp_`).

**Choix reporté au S6/S7** : ouvrir des PR, merger, lancer les workers, prendre les cartes
étiquetées `jarvis` (`forges.trello_label`).

## ADR-027 — S6 : workers Claude Code (02/10/2026)

**Décision.** Une tâche (« code-moi … sur owner/repo ») suit ce chemin :
1. Jarvis la met en file (SQLite, qui survit aux redémarrages) ;
2. il prend **son propre clone partiel** (`--filter=blob:none`), jamais les copies de travail de
   Brightky, et y crée un **worktree** ;
3. **Claude Code** travaille via l'Agent SDK, sur l'abonnement ;
4. Jarvis vérifie le résultat et fait **un commit propre au nom de Brightky** ;
5. il pousse une branche **`jarvis/…`** et ouvre une **PR**, jamais un merge.

**Défense en profondeur** (le worker exécute du code du dépôt et lit des textes externes) :

| Couche | Ce qu'elle impose |
|---|---|
| Hook PreToolUse (`workers/guard.ts`, fonction du daemon, chaque refus audité) | Lecture et écriture **dans le worktree seulement** (realpath : liens symboliques et `..` neutralisés). Jamais `.git/`, `.github/workflows/`, `.gitlab-ci.yml`, `.env*`, `*.pem`. Shell parsé : refus de `git push/remote/config/clone`, `git -c`, `curl/wget/ssh/scp/nc`, `gh/glab`, `sudo/security/osascript`, `npm|pnpm publish/login`, docker, cloud et suppressions hors du worktree. Seuls les outils de code existent : pas de WebFetch, WebSearch ni sous-agents. |
| Sandbox macOS de Claude Code (`sandbox.enabled`, `failIfUnavailable`) | Bash écrit seulement dans le worktree, son tmp et le cache de paquets de Jarvis. Réseau limité aux registres (npm, PyPI, crates, Go, Maven, JSR). Lecture interdite de `~/.ssh`, `~/.aws`, `~/.config/gh`, `~/.npmrc`, Trousseaux, cookies et données de Jarvis. |
| Isolation du SDK | `settingSources: []` : le `.claude/settings.json` d'un dépôt ne peut pas installer de hooks ni de clé API. Le `CLAUDE.md` du projet est injecté comme consigne. Env construit de zéro, abonnement vérifié (`accountInfo`). |
| Vérifications avant envoi | Squash sur la base, diff non vide, aucun fichier protégé, **aucun secret** (rédacteur : secrets connus et motifs de tokens), titre et corps nettoyés de toute mention IA, puis contrôle final du message. |
| Publication | Push d'une branche correspondant à `^jarvis/` uniquement, différente de la base, vers l'URL https du dépôt. Le token passe par un helper d'identifiants à usage unique : jamais dans l'URL, ni dans `.git/config`, ni dans les erreurs. |

- **Attribution** : `settings.attribution = { commit: '', pr: '', sessionUrl: false }`, format
  vérifié dans les types du SDK 0.3.285. Jarvis fait le commit lui-même, avec l'identité git de
  Brightky (ADR-023).
- **Niveau** : `worker_start` est N1. Brightky a décidé que les PR s'ouvrent sans demander. Le
  merge reste hors de portée.
  - Si la consigne est écrite après lecture d'un contenu externe (issue, carte), elle est
    **encadrée comme donnée** dans le prompt du worker.
- **Garde-fous** : `max_turns` 150 et `max_budget_usd` 15 (équivalent API) par tâche. La file
  s'arrête avant d'entamer la réserve interactive du quota (`quota.reserve_interactive_pct`).
  STOP annule tout, et une tâche interrompue par un redémarrage est marquée en échec, jamais
  reprise à l'aveugle.
- **Caches** : npm, pnpm, pip, cargo et go pointent vers `workers.dir/cache`, partagé entre les
  tâches. C'est accessible en écriture dans la sandbox, séparé des caches de Brightky, et évite de
  tout retélécharger (connexion limitée).

**Tests** :
- 8 tests du garde-fou ;
- 6 tests e2e sur un vrai git (un dépôt nu joue GitHub) avec un faux agent : commit unique à son
  nom et sans trailer, branche `jarvis/`, PR ; fichier CI refusé ; secret dans le diff, donc
  rien n'est poussé ; aucun changement, donc pas de PR ; STOP ; consigne externe encadrée.

**Non testé en réel** : l'agent Claude Code lui-même. Il faut le token d'abonnement (`jarvis auth
set-token`) et un token GitHub, ce qui consomme du quota. C'est la première chose à faire avec
Brightky.

**Complément (03/10/2026), la preuve avant la PR** (rapport « Jarvis pour les équipes tech »,
proposition 4) : le compte rendu « tests OK » d'un worker est un texte du modèle, pas une preuve.
- **Ce qui a vraiment tourné** : les hooks `PostToolUse` et `PostToolUseFailure` du SDK
  enregistrent chaque commande Bash de vérification et son vrai résultat (succès ou échec), ainsi
  que chaque modification de fichier. Un module pur (`workers/proof.ts`) reconnaît ces commandes :
  test, lint, typecheck et build pour une quinzaine d'écosystèmes.
- **Ce que Jarvis en tire** : PR prête si la dernière exécution de chaque vérification est verte et
  qu'aucun fichier n'a changé depuis. Sinon, brouillon avec un avertissement explicite.
- **Écarté** : relancer les tests nous-mêmes hors du bac à sable. Ce serait exécuter le code du
  dépôt sur le Mac sans la sandbox du worker.

## ADR-028 — S7 : des cartes Trello aux workers, en parallèle (02/10/2026)

- **`trello_take`** (N2, **une validation pour le lot**) prend les cartes étiquetées `jarvis` sur
  tous les tableaux ouverts (5 au plus par appel). Les cartes déjà prises ne sont jamais reprises.
- **Dépôt de la carte** : ligne `repo: owner/repo` (préfixe `gitlab:` possible) dans la
  description, sinon la correspondance `forges.trello_boards`. Les chemins contenant `..` sont
  refusés. Une carte sans dépôt est ignorée, avec l'indication de la correction à faire.
- **Consigne du worker** : titre, description, checklist et lien de la carte, **toujours
  encadrés comme donnée externe** (une carte peut être écrite par n'importe quel membre du
  tableau).
- **Cycle de la carte** :
  - au départ, elle passe dans « En cours » ;
  - quand la PR est ouverte, elle reçoit un commentaire « PR : <lien> » et passe dans
    « À relire ». Ce commentaire est au nom de Brightky, sans mention de Jarvis (ADR-023) ;
  - en cas d'échec, la carte reste en cours et Brightky est prévenu par le tableau de bord ou la
    voix. Aucun détail d'erreur n'est publié pour l'équipe.
- **Parallélisme** : `workers.max_parallel` vaut 2 par défaut dans l'exemple (3 au plus avec
  l'abonnement Max 5x). Un **verrou par dépôt** sérialise clone, fetch et worktree : un test en
  parallèle a révélé la course.
- **Relecture vocale** : `worker_status` donne la PR, puis `pr_read` permet à Jarvis d'expliquer
  le diff en mots simples.

## ADR-029 — Mains libres : « Jarvis, … » (02/10/2026, avancé depuis le S11)

**Demande de Brightky** : parler à Jarvis à tout moment depuis son Mac, sans passer par la ligne
de commande ni par un raccourci clavier.

**Décision** : un mot d'éveil par transcription, 100 % local, sans modèle de mot d'éveil à
entraîner.
- **Détection de parole** : le micro reste ouvert dans Jarvis.app. **Silero VAD** (FluidAudio,
  par tranches de 256 ms, environ 1 ms de calcul par tranche) découpe la parole en énoncés : début,
  puis fin après 0,6 s de silence, 14 s au plus, avec 0,5 s de pré-enregistrement pour ne pas
  couper le premier mot.
- **Lecture** : chaque énoncé est lu par **Parakeet** (environ 100 ms). Seuls ceux qui
  **commencent par le nom** passent au cerveau : « Jarvis, … », « Hey / OK / Dis Jarvis, … ».
  Les variantes proches sont acceptées (Jervis, Javis, Charvis…) ; « Jardin » et « Travis » ne
  le sont pas.
- **Cas particuliers**
  - « Jarvis » seul réveille Jarvis : l'énoncé suivant, dans les 8 s, est la commande.
  - Pendant une confirmation N2 parlée, « oui » ou « non » est accepté sans le nom.
- **L'oreille est fermée** quand Jarvis écoute par la touche, réfléchit ou parle, pour qu'il ne
  s'entende pas lui-même. ⌥Espace reste disponible et permet de lui couper la parole.
- **Rien n'est enregistré sur disque**. Les énoncés qui ne commencent pas par le nom sont jetés.
- **Réglage** : `wake` dans `voice.json`, actif par défaut, et dans Tableau de bord › Réglages ›
  Voix.

**Risque assumé (SECURITY R13)** : une personne présente, une vidéo ou la télé peut dire
« Jarvis, … ». Les garde-fous restent ceux de la voix :
- N2 demande un « oui » ;
- N3 n'est jamais validé à la voix (PIN au terminal ou au tableau de bord) ;
- N4 reste interdit ;
- STOP reste disponible en permanence (⌃⎋).

**Mesure** : les 6 extraits de test, voix FR et EN, sont correctement classés (commande, mention
de Jarvis, « jardin », phrase sans appel). Un « Hey Jarvis » prononcé par une voix française de
synthèse a été lu « Ai-je revis ? » : d'où la consigne de commencer par « Jarvis ».

**Corrigé au passage** : la bascule vers les voix neuronales n'avait pas lieu si Brightky parlait
pile au moment où elles finissaient de charger. Elle se fait désormais au premier retour au repos.

**Complément (02/10/2026)** : Brightky ne veut jamais avoir à maintenir de touche.
- **Appui court** sur ⌥Espace (moins de 0,35 s) : il arme l'oreille mains libres pendant 8 s, et
  la fin de phrase est détectée par la VAD.
- **Après chaque réponse** : 10 s pendant lesquelles une relance n'a pas besoin du nom.
- **Écho** : un énoncé dont au moins 60 % des mots viennent de ce que Jarvis vient de dire est
  ignoré. C'est sa propre voix renvoyée par la pièce, pas une demande.

**Complément (03/10/2026)** : Brightky veut pouvoir dire « Bon, Jarvis… » et toutes les entrées en
matière naturelles.
- **Avant le nom** :
  - salutations et mots de remplissage connus (environ 150, FR et EN) ;
  - expressions figées (« au fait », « du coup », « s'il te plaît », « by the way ») ;
  - ou au plus deux mots inconnus, si ce n'est pas le début d'une phrase : pas de sujet (« je »,
    « c'est »), de déterminant ni de possessif (« le projet », « mon projet »).
- **Après le nom** : sans virgule, un verbe à la troisième personne (« Jarvis est lent », « Jarvis
  m'a dit ») signale qu'on parle *de* lui. Rien ne se déclenche.
- **Mesure** : 63 phrases de synthèse passées par la vraie chaîne (VAD, Parakeet, détecteur) :
  - 47 déclenchements sur 55 attendus ;
  - 0 sur les 8 phrases qui parlent de Jarvis ;
  - ratés restants : le nom n'est pas transcrit (« l'armée », « la vie ») par une voix robotique.

  Piste suivante : le *vocabulary boosting* de Parakeet, s'il ne demande pas un gros
  téléchargement.

## ADR-030 — Le bureau : fenêtres, écrans, fermer des apps (02/10/2026)

**Demande de Brightky** : « Jarvis doit pouvoir fermer des apps, voir mon écran, faire des
manipulations de mon écran, manipuler mon PC. » Jusqu'ici, Jarvis voyait la fenêtre d'une app et
y cliquait ou tapait, mais il ne pouvait ni fermer une app, ni voir un écran entier, ni ranger les
fenêtres.

**Décision** : trois outils de plus, servis par Jarvis.app (Accessibilité, Enregistrement de
l'écran), sans AppleScript.
- **`windows_list`** (N0) : les écrans (1 = celui de la barre de menus, puis de gauche à droite),
  chaque fenêtre visible avec son app, son titre et son écran, et les apps ouvertes sans fenêtre
  visible. Les titres viennent du contenu d'autres personnes : la session est teintée.
- **`screen_look {display}`** (N0) : un écran entier. Les apps protégées sont **exclues de la
  capture** par ScreenCaptureKit : elles n'apparaissent pas, on voit ce qu'il y a derrière.
  Pour agir dans une app, Jarvis la regarde d'abord elle-même (`screen_look {app}`) : les clics
  gardent les mêmes contrôles (libellé réel sous le pointeur, `commit`).
- **`app_quit`** (N2, une validation pour toute la liste) : comme ⌘Q, **jamais de fermeture
  forcée**. Une app qui a du travail non enregistré demande d'enregistrer et reste ouverte : c'est
  Brightky qui répond. Les apps protégées et le Finder ne sont jamais quittés.
- **`window_manage`** : premier plan, masquer / afficher, réduire / restaurer, plein écran,
  agrandir, moitiés gauche / droite / haut / bas, centrer, éventuellement sur un autre écran : N1
  (rien ne se perd). Fermer une fenêtre : N2.

**Défense en profondeur** : l'app refuse d'elle-même de quitter, ranger ou capturer une app
protégée (identifiant de bundle), même sur ordre du daemon.

**Écarté** : la fermeture forcée (perte de travail), et les clics à l'échelle de l'écran entier.
Le contrôle « ce qui est réellement sous le pointeur » reste fait app par app.

## ADR-031 — L'île Jarvis (03/10/2026)

**Contexte** : la recherche « Jarvis pour les équipes tech » (rapport local, proposition 6) et les
visuels de référence (Vibe Island, Wispr Flow, « Search or Ask » de macOS) convergent. Une
interface vocale de bureau réussie est discrète, montre ce qu'elle entend et ce qu'elle fait,
et garde toujours le STOP à portée de main.

**Décision** :
- **Le panneau** : un `NSPanel` non activant, au-dessus de la barre de menus (niveau `mainMenu + 3`),
  sur tous les bureaux. Il est collé au bord haut sous une encoche, juste sous la barre de menus
  sinon.
  - Sa taille suit exactement le contenu SwiftUI (préférence de taille), donc aucune zone
    transparente ne capte les clics.
  - Masqué au repos.
- **Un seul état affiché**, par priorité : STOP, validation, action sur le Mac, écoute, réflexion,
  parole, workers. Cette priorité est une fonction pure (`IslandMode.from`), testée.
- **Les niveaux audio sont réels** : RMS du micro (oreille mains libres, écoute par touche) et de
  la sortie de PocketTTS (tap sur le mixeur), lus à 30 images par seconde. Seul un nombre est
  gardé, jamais l'audio. Le réglage Réduire les animations est respecté.
- **Les validations ne changent pas de niveau** : l'île est une surface de plus pour N2 et N3, au
  même titre que le tableau de bord et la voix. N3 demande le PIN et reste refusé dans une session
  teintée, comme ailleurs.
- **Le STOP de l'île est en un clic**, parce qu'il n'apparaît que lorsque Jarvis pilote une app.
  Il annule l'action en cours (`cancelAll`) et enclenche STOP avec la source « île Jarvis ».
  Les autres boutons STOP restent en deux clics.

**Écarté** :
- le HUD plein écran façon Iron Man et l'orbe 3D permanent (coût GPU, distraction) ;
- Liquid Glass : le Mac est sous macOS 15, d'où un noir opaque, lisible sur tous les fonds ;
- l'île au survol de l'encoche au repos, à revoir si le besoin se confirme.

## ADR-032 — File de revue déterministe (03/10/2026)

**Contexte** (rapport « Jarvis pour les équipes tech », proposition 1) : le goulot d'étranglement
s'est déplacé vers la relecture, et le bruit est la première cause d'abandon des bots de revue.

**Décision** :
- **`review_queue` (N0)** réunit les PR où Brightky est relecteur et celles des workers.
- **Le classement est du code, pas du modèle** :
  - les chemins des fichiers donnent les zones à risque ;
  - le poids vient de l'ancienneté (plafonnée à 14 jours) et des zones ;
  - une CI rouge, des changements demandés ou un brouillon font descendre la PR : c'est à
    l'auteur d'agir.
- **Coût réseau maîtrisé** : seulement les métadonnées, jamais le diff. Environ 4 appels par PR,
  12 PR au plus.
- **Pré-revue** : les consignes limitent la sortie aux problèmes sévères (5 au plus, fichier:ligne
  et raison). Poster reste N2, avec le texte exact.

**À venir** : quand Brightky juge un commentaire inutile, en faire une règle dans le CLAUDE.md du
dépôt, et afficher la file dans le brief du matin.

## ADR-033 — Serveurs, déploiements et secrets de CI (03/10/2026)

**Demande de Brightky** : « Jarvis doit pouvoir configurer les secrets sur un repo pour qu'il déploie
sur un serveur, se connecter sur un serveur pour faire un déploiement… »

**Contexte** : c'est le chantier le plus risqué de tous, celui de la production et des
identifiants. Les incidents de 2026 du rapport « Jarvis pour les équipes tech » le montrent :
`terraform destroy` sur la prod, injection par les logs, faux mode lecture seule.

**Décision** :
- **Périmètre déclaré par Brightky** dans la politique scellée (`ops.servers`) : serveurs,
  environnements, et pour chaque app le déploiement (argv distant ou webhook Coolify) et la commande
  de logs. Jarvis ne peut rien ajouter.
- **SSH sans compromis** : clés ou agent de Brightky lus par `ssh` seul, `BatchMode`,
  `StrictHostKeyChecking=yes`, argv échappé mot à mot, environnement minimal.
- **Niveaux par environnement** :
  - N0 : lectures d'une liste fixe.
  - Changements : N3 en prod (PIN, et refus si la session a lu un contenu externe), N2 ailleurs.
  - N4 : ce qui détruit des données, modifie des accès ou exécute du code illisible. Le travail
    privilégié passe par les scripts que Brightky a écrits et déclarés.
- **Les valeurs secrètes ne passent jamais par le modèle** : un coffre au Trousseau
  (`jarvis vault set`), ou une génération locale. GitHub via `gh secret set` (stdin), GitLab via son
  API. Toujours N3.
- **CI vers serveur** : une clé par app. La clé publique est installée avec
  `restrict,command="<déploiement>"`, donc la CI ne peut que déployer. Les secrets `DEPLOY_*` vont
  sur le dépôt, et le workflow est fourni à relire.
- **Les workers ne déploient pas** : ni réseau ni identifiants dans leur sandbox. C'est Jarvis qui
  déploie, avec ses outils au périmètre fixe.

**Écarté** :
- donner un shell distant libre au modèle ;
- écrire le workflow de CI par l'API (il faudrait la permission « workflows » sur les tokens) ;
- stocker des clés de prod longue durée hors du Trousseau ;
- laisser Claude Code déployer depuis un worker.

## ADR-037 — LinkedIn : publier par l'API officielle, apprendre de l'export (03/10/2026)

**Demande de Brightky** : des posts LinkedIn « qui font du sens », avec des captures de texte. Jarvis
doit apprendre des publications qui ne marchent pas et être « un super manager pour gérer mes
communautés ».

**Contexte** (recherche du 03/10/2026, `research_notes/LinkedIn pour Jarvis/`) :
- **Publier** : seul « Share on LinkedIn » (`w_member_social`) est gratuit et sans revue. Il sert à
  écrire, pas à lire.
- **Statistiques** : celles des membres (`memberCreatorPostAnalytics`) sont réservées aux entreprises
  immatriculées. L'export XLSX d'Analytics est ouvert à tous.
- **Règles** : le contrat interdit les scripts, extensions et méthodes automatisées sur le site
  (§8.2), et les conditions de l'API interdisent d'automatiser la publication.
- **Application** : elle se durcit (détection de milliers d'extensions, Pages d'outils supprimées).

**Décision** :
- **Publication** par l'API officielle, uniquement au moment de la validation N2 du texte exact.
  Aucune file de publication automatique.
- **Visuels** :
  - cartes rendues localement par Jarvis.app (SwiftUI) ;
  - captures de fenêtre ;
  - un PDF des dossiers autorisés.
  - Rien d'autre ne peut être joint.
- **Apprentissage** : l'export XLSX est lu en local. Chaque post est rapporté à la médiane des 10
  précédents (tops ×1,5, flops ×0,6). Les formats sont comparés par hypothèses, avec au moins 3
  posts de chaque côté. Un post publié par Jarvis est relié à ses statistiques par sa date (l'URN
  publié et celui de l'export diffèrent).
- **Navigateur** : linkedin.com est interdit au pilotage, dans le daemon et dans l'app.

**Écarté** :
- piloter linkedin.com, même pour lire ses propres statistiques ;
- les API non officielles et le partage du cookie de session ;
- la programmation automatique ;
- le Community Management API, tant qu'il n'y a pas de structure immatriculée.

## ADR-036 — Les workers vérifient l'interface dans un vrai navigateur (03/10/2026)

**Contexte** (rapport « Jarvis pour les équipes tech », proposition 13) : un worker qui modifie un
frontend ne voit jamais le résultat. La boucle utile est gratuite et locale : serveur de dev,
captures à plusieurs largeurs, audits d'accessibilité et de performance. Mais la sandbox des
workers n'ouvre le réseau qu'aux registres de paquets, et la connexion de Brightky est mesurée.

**Décision** :
- **Option scellée, désactivée par défaut** : `workers.ui_checks: { enabled, ports, widths }`,
  validée par zod (ports ≥ 1024, sans doublon, ports de services refusés ; 1 à 5 largeurs).
- **Activée seulement pour un frontend web**, détecté à l'exécution dans les `package.json` (à la
  racine, dans `apps/*`, `packages/*`, `web/`…). Sinon, rien ne change pour le worker.
- **Tout tourne dans la sandbox du worker** : serveur de dev, Chrome, Lighthouse, Playwright.
  - Chrome hérite donc des mêmes limites : écriture confinée, Internet limité aux registres.
  - La seule ouverture est `allowLocalBinding: true`, plus les noms Mach du rendez-vous de
    Chrome (`*.MachPortRendezvousServer.*`) et le dossier de la tâche en écriture.
- **Chrome du Mac en ligne de commande** (`--headless=new --screenshot --window-size`), avec un
  profil jetable. Aucun navigateur n'est téléchargé, et `PUPPETEER_SKIP_DOWNLOAD` et
  `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD` sont posés. Lighthouse, axe et Playwright tournent seulement
  s'ils sont déjà des dépendances du projet.
- **Tout ce qui compte est imposé par le code** : sandbox, garde-fou (Chrome, URL, hôte d'écoute,
  téléchargements, emplacement des fichiers) et contrôle du PNG avant de compter une capture. Les
  consignes du worker ne font qu'expliquer ces règles.
- **Preuve et PR** : les captures et les audits sont des vérifications comme les autres. Une
  capture sans PNG réel est rouge. La section « Interface vérifiée » vient des commandes
  réellement exécutées, jamais du texte du worker. Les captures sont gardées à côté du journal de
  la tâche, hors de git.

**Ce que le SDK permet et ne permet pas** (types de `@anthropic-ai/claude-agent-sdk` 0.3.285,
`SandboxNetworkConfig`, `SandboxSettings`) :
- Permet : `allowedDomains` et `deniedDomains`, avec un suffixe `:port`, mais pour le proxy
  seulement ; `allowLocalBinding` (booléen, macOS) ; `allowUnixSockets` (par chemin) ;
  `allowMachLookup` (par nom, joker en fin) ; `filesystem.allowWrite` et `denyRead`.
- Ne permet pas : filtrer la boucle locale par port. Dans le profil Seatbelt généré,
  `allowLocalBinding` donne `network-bind` et `network-inbound` sur `*:*`, et `network-outbound`
  vers `localhost:*`. Les adresses locales sont dans `NO_PROXY`, donc le filtre du proxy ne les
  voit pas. Il n'y a pas non plus de profil Seatbelt personnalisé. D'où le risque résiduel R14.

**Écarté** :
- **Serveurs MCP navigateur** (Chrome DevTools MCP, Playwright MCP). Un serveur MCP stdio est lancé
  par le processus Claude Code, **hors de la sandbox du Bash**. Le Chrome qu'il piloterait
  exécuterait le code du dépôt avec tout le réseau du Mac (Internet, réseau local), et
  `evaluate_script` contournerait la liste blanche.
  - Aucun n'est installé sur le Mac (vérifié le 03/10/2026), et leurs options n'ont pas pu être
    vérifiées hors ligne.
  - À revoir s'ils peuvent tourner sous un profil `sandbox-exec` propre, avec un filtre par port.
- **Navigateurs Playwright téléchargés** : plusieurs centaines de Mo sur une connexion mesurée,
  alors que Chrome est déjà installé.
- **Lancer Chrome ou le serveur de dev depuis le daemon** : ce serait exécuter le code du dépôt
  hors de la sandbox (même raison que pour la preuve avant la PR).
- **Mettre `localhost:<port>` dans `allowedDomains`** : sans effet, puisque le trafic local
  contourne le proxy.
- **Captures dans le dépôt ou jointes à la PR** : elles alourdiraient l'historique, et une capture
  peut montrer des données locales. Elles restent sur le Mac, avec le journal de la tâche.

**Non testé en réel** : Chrome dans la sandbox de Claude Code. Il faut vérifier s'il a besoin
d'autres services Mach ou de `--no-sandbox` (sandbox imbriquée), et si ses écritures restent dans
le profil jetable. Il faut aussi tester Lighthouse via chrome-launcher, et le serveur de dev de
Next, Vite et Storybook sur `127.0.0.1`. Premier essai à faire avec Brightky, sur un vrai frontend.

## ADR-035 — Kit de scanners DevSecOps locaux (03/10/2026)

**Contexte** (rapport « Jarvis pour les équipes tech », propositions 8, 9 et 10) :
- les scanners déterministes (gitleaks, OSV-Scanner, zizmor, Checkov, Trivy, Grype, Opengrep)
  sont gratuits, open source et s'installent par Homebrew ;
- les couches d'IA open source (k8sgpt, HolmesGPT…) exigent une clé API ou un modèle local lourd,
  incompatibles avec l'abonnement seul et la connexion mesurée ;
- selon Datadog, seules 18 % des vulnérabilités « critiques » le restent une fois le contexte
  appliqué : une liste brute de CVE sert peu, il faut trier par atteignabilité et exposition ;
- « lecture seule » ne veut pas dire « sans réseau » : les bases de vulnérabilités se
  téléchargent ;
- un scanner peut lui-même être compromis (Trivy, mars 2026).

**Décision** :
- **Les scanners trouvent, Claude trie et explique.**
  - Deux outils N0 : `security_tools` (inventaire, installation) et `security_scan` (contenu
    externe).
  - Le travail déterministe (exécution, parsing, forme commune, tri par gravité ajusté d'environ
    un cran par les signaux, plafonds) est du code. Le modèle ne reçoit qu'un résumé borné et ne
    choisit aucun argument de ligne de commande.
- **Catalogue fixe d'argv**, réunis dans un seul fichier pour être ajustés facilement :
  - `gitleaks dir --report-format json --report-path - --redact --no-banner <dossier>` ;
  - `osv-scanner scan source --recursive --format json [--offline] <dossier>` ;
  - `zizmor --format json --offline <dossier>` ;
  - `checkov --directory <dossier> --framework … --output json --compact --quiet --skip-download` ;
  - `trivy image --format json --quiet --scanners vuln [--skip-db-update --skip-java-db-update
    --offline-scan] -- <image>` et `trivy config --format json --quiet <dossier>` ;
  - `grype --output json --quiet -- <image>` ;
  - `opengrep|semgrep scan --config <règles locales> --json --quiet <dossier>`.

  Les drapeaux sont placés avant la cible, parce qu'urfave/cli s'arrête au premier argument
  positionnel.
- **Exécution** : l'exécuteur sans shell du paquet policy, plutôt que `execFile`. On garde la même
  garantie (argv, `shell: false`), et on gagne la mise à mort du groupe de process, car checkov
  lance des sous-process. Sont aussi bornés :
  - le délai par scanner : délai du gate moins 15 s, pour que le résumé revienne toujours ;
  - la sortie (24 Mo) ;
  - le nombre de constats (5 000 par outil, 40 affichés).
- **Contrôles par défaut** : secrets, dépendances, CI, IaC, et la SAST si des règles locales
  existent. L'image est sur demande. Ce qui ne peut pas tourner est dit, avec la commande
  d'installation : Jarvis n'installe jamais rien.
- **PR des workers** : contrôle des nouvelles dépendances par lecture des manifestes, et gitleaks
  sur les lignes ajoutées s'il est installé. Rien n'est bloqué faute d'outil. Une dépendance
  suspecte garde la PR en brouillon, avec l'avertissement en tête.

**Écarté** :
- **`trufflehog --verify`** : la vérification active envoie le secret au fournisseur. Elle n'est pas
  proposée (au mieux N3 plus tard).
- **`semgrep --config auto`** et les règles du registre : réseau, et licence des règles Semgrep.
  Seules les règles locales sont acceptées.
- **Laisser le modèle composer les commandes via `shell_run`** : les scanners ne sont pas dans la
  liste blanche, donc N3 et refusés après lecture d'un contenu externe ; surtout, aucune garantie
  sur `--redact` ni sur le réseau. Un catalogue fixe se teste.
- **Installer les scanners automatiquement** : téléchargements de 100 Mo et plus sur une connexion
  mesurée, et une installation est une action sur la chaîne d'approvisionnement : c'est à
  Brightky de la faire.
- **Repli de la vérification des dépendances sur grype ou trivy** quand osv-scanner manque : ce
  serait un téléchargement de base de vulnérabilités surprise. Ces outils restent pour les images.
- **Pare-feu de dépendances complet** (existence dans le registre, âge, téléchargements, `sfw`) :
  il faut le réseau. C'est la prochaine étape : il faudra ouvrir la sandbox des workers vers
  Socket et décider du niveau (N4 pour un paquet inexistant ou trop récent).
- **Correctifs automatiques des workflows** (épinglage par SHA, proposition 10) : à faire en code
  déterministe, avec une PR **N3** qui touche `.github/workflows` ; c'est hors de ce lot.

**Non vérifié sur un vrai binaire** (aucun scanner n'est installé sur le Mac de développement) :
- les drapeaux ci-dessus, le format JSON exact de chaque version et les codes de sortie (zizmor
  10 à 14, osv-scanner 128 « aucun paquet ») ;
- `trivy --skip-check-update`, le comportement d'opengrep sans `--metrics`, `gitleaks dir` sur un
  fichier unique (contrôle du diff des workers) ;
- les tailles de téléchargement, qui sont des ordres de grandeur.

À refaire avec Brightky : `security_tools`, puis un `security_scan` sur un vrai dépôt, sur Wi-Fi.
