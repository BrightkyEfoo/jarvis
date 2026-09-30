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
