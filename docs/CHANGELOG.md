# Changelog

## 0.5.0 — Recherche web et YouTube, avancées depuis le S13 (01/10/2026)

### Ajouté
- **`web_research`** : synthèse avec sources par un agent isolé (WebSearch côté Anthropic : aucune
  page téléchargée, incluse dans l'abonnement). Mode `quick` (Sonnet) ou `deep` (Opus).
- **`youtube_search`** et **`youtube_watch`** : Jarvis « regarde » une vidéo à partir de ses
  sous-titres (sans télécharger la vidéo) et en fait un résumé horodaté, ou répond à une question.
- yt-dlp installé via uv (environ 14 Mo, sans Deno ni Python 3.14).
- **Tests** : 18 nouveaux, dont un faux binaire yt-dlp qui vérifie les arguments exacts.

### Corrigé
- Le schéma JSON de la quarantaine des mails était refusé par le CLI (format draft 2020-12) : la
  quarantaine retombait silencieusement sur les métadonnées. Le schéma est maintenant au format
  draft-07.

## 0.4.0 — Sprint 4 : mails, agenda, briefing, confirmations vocales, launchd (01/10/2026)

### Ajouté
- **`@jarvis/connectors`** :
  - Gmail et Google Agenda en REST direct (OAuth PKCE, token dans le Trousseau) ;
  - IMAP/SMTP générique (TLS obligatoire, certificat épinglé possible via `ca_pem`).
- **Lecteur en quarantaine** : les mails sont résumés par un modèle sans outil, au format JSON
  contraint ; les injections sont signalées ; repli sur les métadonnées en cas d'échec.
- **Outils** : `mail_triage`, `mail_read`, `mail_draft` (N1), `mail_send` (N2, empreinte du
  brouillon vérifiée), `calendar_list` et `briefing`.
- **Voix** : confirmations N2 à l'oral (« Tu confirmes ? » → oui/non), refus côté serveur des N3
  par la voix, résumés reformulés en français pour l'oral.
- **launchd** : `jarvis service install|uninstall|status|logs`, plus `ops/scripts/mac-always-on.sh`.
- **CLI** : `jarvis google connect`, `jarvis mail add|status|test`.
- **Docs** : `docs/SETUP-GOOGLE.md`, ADR 019 et 020.
- **Tests** : 12 tests connecteurs, 9 tests e2e du Sprint 4 (dont la démo du mois 1), 3 tests
  launchd et 20 nouveaux tests Swift (confirmations).

### Démo du mois 1, couverte de bout en bout par les tests
Briefing → réponse à un mail en brouillon → « tu confirmes ? » → « oui » à la voix → envoyé, avec
l'approbation `voice` inscrite dans l'audit.

### À noter
- Les boîtes pro : `mail.transitsoftservices.com` n'existe plus dans le DNS, et `scriptify.cm` ne
  répond pas en IMAP/SMTP depuis ton réseau. Il faut les bons paramètres de l'hébergeur.

## 0.3.0 — Sprint 3 : voix en push-to-talk, 100 % locale (01/10/2026)

### Ajouté
- **`apps/voice`** : app native Swift `Jarvis Voice` (228 Ko), sans aucun téléchargement.
  - Maintenir ⌥Espace pour parler ; reconnaissance locale d'Apple en `fr-FR` et `en-US` en
    parallèle, avec choix automatique de la langue.
  - Réponse lue phrase par phrase pendant qu'elle s'écrit (Thomas / Daniel).
  - Barge-in : réappuyer coupe la parole.
  - Latence affichée à chaque tour (reconnaissance, premier texte, voix).
- **`jarvis voice [build|test|selftest]`** : l'autotest reconnaît des phrases générées par `say`,
  sans micro, et fait parler Jarvis.
- **Daemon** :
  - `ask` accepte `trigger: voice` (enregistré dans l'audit, style oral) ;
  - nouvelle commande `interrupt` (barge-in, distincte de STOP) ;
  - `Brain.interrupt()`.
- **Tests** : 18 tests Swift (découpage en phrases, nettoyage, choix de langue) et 2 tests e2e
  (déclencheur voix, barge-in en moins de 500 ms).

### Mesuré
| Mesure | Résultat |
|---|---|
| Premier son de la voix | 45 ms |
| Reconnaissance EN (fichier) | 242 ms |
| Reconnaissance FR (fichier entier) | 872 ms |

### Notes
- La pile Pipecat, Parakeet et Pocket TTS (environ 2 Go) est reportée faute de data ; voir l'ADR-018.
- Les permissions Micro et Reconnaissance vocale sont attribuées à « Jarvis Voice » ; une
  recompilation les fait redemander (signature ad hoc).

## 0.2.0 — Sprint 2 : outils macOS, mémoire, routeur, coûts (30/09/2026)

### Ajouté
- **Outils macOS** : `projects_list`, `app_open`, `url_open`, `apps_running`, `shortcuts_list`,
  `shortcut_run` et `system_status`. La demande « ouvre VS Code sur le projet X » est couverte.
- **`@jarvis/memory`** :
  - notes Markdown de Brightky (`~/Jarvis/memory`) et faits SQLite FTS5 avec leur provenance ;
  - outils `memory_search`, `memory_remember` et `memory_forget` ;
  - snapshot dans le prompt système (faits externes exclus).
- **Routeur de modèles** : Sonnet 5.5 par défaut, Opus 5.5 pour planifier ou réfléchir en
  profondeur (FR et EN), repli sur Sonnet si le quota Opus est presque épuisé.
- **Compteur de coûts** : usage par tour (modèle, tokens, cache, coût équivalent API, TTFT), pied
  de page dans la CLI, `jarvis costs`, quota par fenêtre dans `jarvis status`.
- **Langues** : Jarvis répond en français ou en anglais selon la langue utilisée.
- **CLI** : `jarvis costs [today|week|month]` et `jarvis memory [list|search|forget|notes]`.
- **Politique** : nouvelles sections `macos` (apps, raccourcis), `projects` et `memory`.
- **Tests** : 270 tests unitaires, e2e et red team (7 cas d'injection), plus 5 budgets de perf.

### Corrigé
- Le coût par requête était cumulé sur toute la session (les totaux du SDK sont cumulatifs) : il
  est maintenant calculé par différence.
- Un échec de `setModel` interrompait la requête : désormais Jarvis reste sur le modèle courant.

### Sécurité
- Les faits issus de contenu externe ne sont jamais réinjectés dans le prompt système, ce qui
  bloque l'empoisonnement de la mémoire.
- Liens venant de contenu externe : N2. Schémas d'URL autres que http(s) : N4.
- Raccourcis liés à des paiements : N4 codé en dur.

### Mesuré (M1 Pro, machine au calme)
| Mesure | Résultat | Budget |
|---|---|---|
| `evaluate` p99 | 250 µs | 1 ms |
| Gate p99 | 729 µs | 2 ms |
| Recherche mémoire p99 | 345 µs | 1 ms |
| Snapshot de session | 278 µs | 5 ms |
| Aller-retour IPC p99 | 31 µs | 5 ms |
| Démarrage du daemon | 44 ms | 300 ms |

Une mesure faite pendant un autre `pnpm test` (load average de 21) montait jusqu'à 3,5 ms : les
budgets supposent une machine au calme.

## 0.1.0 — Sprint 0 : fondations et sécurité (30/09/2026)

### Ajouté
- **Monorepo** : pnpm 12, Node 24 LTS (type stripping, sans build), TypeScript 7, Biome, Vitest 5.
  CI GitHub Actions (Linux, actions épinglées par SHA).
- **`@jarvis/policy`** :
  - niveaux N0 à N4, schéma `policy.yaml` strict, scellement (root + hash) ;
  - `PolicyEngine` pur ; `FsPolicy` (realpath, casse APFS, denylist) ;
  - provenance et taint ; kill switch persistant ; PIN scrypt avec verrouillage ;
  - broker d'approbations ; gate `defineTool()` ;
  - parseur shell tree-sitter à liste blanche de nœuds, classifieur argv avec denylist N4 codée
    en dur, exécuteur sans shell (pipes noyau, groupe de process) ;
  - contre-vérification `sh-syntax` avant l'exécution.
- **`@jarvis/audit`** : SQLite WAL `synchronous=FULL`, triggers append-only, chaîne de hash
  SHA-256, miroir JSONL, `verify()`.
- **`@jarvis/secrets`** : Trousseau (`@napi-rs/keyring`), redacteur (valeurs connues + motifs).
- **`apps/jarvisd`** :
  - daemon sur Unix socket ;
  - orchestrateur Agent SDK durci sur l'abonnement, avec session chaude, hook `PreToolUse`,
    contrôles de surface et de facturation, et STOP sur overage ;
  - 7 outils de démo : `system_time`, `fs_list`, `fs_read`, `fs_write`, `fs_trash` (N3, corbeille),
    `shell_run`, et `outbox_send` (N2 **simulé**) ;
  - CLI `jarvis` en français (approbations interactives, PIN masqué).
- **Tests** : 236 tests unitaires, e2e et red team, plus 4 budgets de perf. Critères d'acceptation
  du S0 couverts de bout en bout avec un modèle scripté.
- **Docs** : ADR 001 à 013, SECURITY.md.

### Mesuré (M1 Pro)
| Mesure | Résultat | Budget |
|---|---|---|
| Démarrage du daemon | 34 à 40 ms | 300 ms |
| `evaluate` p99 | 339 µs | 1 ms |
| Gate p99 (audit durable) | 680 µs | 2 ms |
| Aller-retour IPC p99 | 29 µs | 5 ms |
| Arrêt d'une commande par STOP | < 500 ms | — |
| Démarrage à chaud du process modèle | 1,2 à 3,1 s | — (masqué par le pré-chauffage) |

### Notes
- pnpm a ajouté automatiquement des exclusions `minimumReleaseAge` pour l'Agent SDK 0.3.285 et
  Vitest 5.0.3, publiés moins de 24 h avant l'installation.
- `NODE_TLS_REJECT_UNAUTHORIZED=0` a été trouvé dans l'environnement de la session VS Code ; les
  installations ont été faites avec la vérification TLS réactivée.
