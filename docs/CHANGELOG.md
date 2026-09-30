# Changelog

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
