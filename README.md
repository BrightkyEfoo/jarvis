# Jarvis

Assistant vocal et orchestrateur de développement pour macOS : une journée de dev senior passée à
parler, pas à taper. Brightky décide, valide et relit ; Jarvis exécute, dans les limites que le
code lui impose.

**État : Sprint 3.** En place : le moteur de permissions, l'audit, le kill switch, les secrets,
les outils macOS, la mémoire, le routeur Sonnet/Opus et le compteur de coûts. On peut parler à
Jarvis en français ou en anglais, au clavier ou à la voix (push-to-talk, reconnaissance 100 %
locale, 0 Mo à télécharger).

## Ce qui est garanti par le code
- Niveaux **N0 à N4**. Les actions interdites (N4) sont bloquées dans le code et ne peuvent pas être
  débloquées depuis `policy.yaml`.
- Les actions N2, qui parlent en ton nom, attendent ta confirmation. Les N3 demandent en plus le
  **PIN**, et sont refusées dès qu'un contenu externe est entré dans la conversation.
- Aucun shell n'est jamais lancé : chaque commande est parsée, classée, puis exécutée en argv.
- **STOP** coupe tout, persiste après un redémarrage, et la reprise exige le PIN.
- Le journal d'audit est append-only et chaîné par hash (`jarvis audit verify`).
- **Zéro coût hors abonnement Claude.** Aucune clé API n'est acceptée, et un overage payant
  déclenche STOP.

Détails : [docs/SECURITY.md](docs/SECURITY.md) · décisions : [docs/DECISIONS.md](docs/DECISIONS.md)
· historique : [docs/CHANGELOG.md](docs/CHANGELOG.md)

## Installation (une fois)

```bash
nvm install            # Node 24 LTS, version épinglée dans .nvmrc
pnpm install           # refuse de tourner si NODE_TLS_REJECT_UNAUTHORIZED=0

# Commande `jarvis` dans le PATH
ln -s "$PWD/apps/jarvisd/bin/jarvis" ~/.local/bin/jarvis

# 1. Token d'abonnement (Claude Max). `claude setup-token` ouvre le navigateur.
claude setup-token
jarvis auth set-token          # colle le token : il va dans le Trousseau

# 2. PIN pour les actions N3 et la reprise après STOP
jarvis pin set

# 3. Politique : relis config/policy.example.yaml, puis scelle-la
ops/scripts/seal-policy.sh config/policy.example.yaml   # demande sudo pour la copie root
```

## Utilisation

```bash
jarvis daemon                  # policy scellée (production)
jarvis daemon --dev            # policy du repo non scellée ; N3 désactivé

jarvis "quelle heure est-il ?"
jarvis "ouvre VS Code sur le projet CodeVault"
jarvis "plan the next sprint"   # Opus pour la planification, Sonnet sinon ; FR ou EN
jarvis costs week              # consommation (équivalent API) et quota de l'abonnement
jarvis memory                  # ce que Jarvis retient · `jarvis memory notes` pour tes notes
jarvis voice                   # maintiens ⌥Espace et parle ; réappuie pour couper la parole
jarvis voice selftest          # vérifie la reconnaissance FR/EN et la voix, sans micro
jarvis stop                    # STOP : tout s'arrête
jarvis resume                  # reprendre (PIN)
jarvis approvals --watch       # valider depuis un autre terminal
jarvis audit tail              # dernières entrées du journal
jarvis audit verify            # intégrité du journal
jarvis new                     # nouvelle conversation
```

## Développement

```bash
pnpm check     # typecheck (tsc 7) + lint (Biome) + tests + budgets de perf
pnpm test      # tests unitaires, e2e et red team (sans appel au modèle : coût nul)
pnpm perf      # budgets : evaluate < 1 ms, gate < 2 ms, IPC < 5 ms, démarrage < 300 ms
```

Arborescence :
- `apps/jarvisd` : daemon, orchestrateur, outils, CLI ;
- `apps/voice` : app vocale native Swift (push-to-talk) ;
- `packages/policy` : permissions, gate, shell ;
- `packages/audit` : journal ;
- `packages/secrets` : Trousseau et rédaction ;
- `packages/memory` : mémoire (notes Markdown, faits FTS5, usage) ;
- `config/` : policy d'exemple ;
- `ops/scripts/` : scellement ;
- `tests/{e2e,redteam,perf}`.

---

*fait avec ❤️ par [Brightky Efo'o](https://brightkyefoo.cm)*
