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
