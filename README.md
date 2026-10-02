# Jarvis

Assistant vocal et orchestrateur de développement pour macOS : une journée de dev senior passée à
parler, pas à taper. Brightky décide, valide et relit ; Jarvis exécute, dans les limites que le
code lui impose.

**État : Sprints 0 à 7 (mois 2), voix neuronales et pilotage du Mac.** En place : le moteur de permissions, l'audit, le kill switch,
les secrets, les outils macOS, la mémoire, le routeur Sonnet/Opus et le compteur de coûts. Jarvis
répond à la voix (push-to-talk, 100 % local, voix neuronales) en français et en anglais, lit Gmail, IMAP et
l'agenda via un lecteur en quarantaine, fait le briefing du matin, rédige des brouillons et ne les
envoie qu'après ton « oui ». Il fait aussi des recherches web sourcées et résume des vidéos YouTube
à partir de leurs sous-titres. Un tableau de bord natif (barre de menus) montre tout ce qu'il fait
et permet de le contrôler. Quand il n'y a pas d'API, il pilote ton navigateur, Notes, Rappels et
n'importe quelle app, sans jamais toucher aux paiements ni aux mots de passe. Il tourne en service launchd.

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

# 3. Gmail + Agenda : suis docs/SETUP-GOOGLE.md, puis
jarvis google connect ~/Downloads/client_secret_XXXX.json perso

# 4. GitHub, GitLab, Trello : suis docs/SETUP-FORGES.md, puis
jarvis github connect && jarvis trello connect

# 5. Politique : relis config/policy.example.yaml, puis scelle-la
ops/scripts/seal-policy.sh config/policy.example.yaml   # demande sudo pour la copie root
```

### Pilotage du Mac (Jarvis.app)

Jarvis utilise ton navigateur et tes apps quand il n'y a pas d'API. Au premier usage, macOS
demande les autorisations pour **Jarvis** (jamais pour Node ou le Terminal) :

- **Accessibilité** et **Enregistrement de l'écran** : Réglages Système › Confidentialité et
  sécurité ;
- **Automatisation** d'Arc ou Chrome, de Notes et de Rappels : macOS le demande à la première
  action ;
- **Chrome uniquement** : menu Affichage › Options pour les développeurs › « Autoriser JavaScript
  depuis les événements Apple ».

### Voix neuronales (une fois, environ 2 Go)

Au premier lancement, Jarvis.app télécharge Parakeet (reconnaissance) et PocketTTS (voix
françaises et anglaises), puis les compile pour la puce. Cela prend quelques minutes, une seule
fois. En attendant, les voix Apple répondent. Tout tourne sur le Mac : aucun son ne part en
ligne. Les voix françaises clonées viennent de dons de voix (voir
`apps/mac/Resources/voices/CREDITS.md`).

Arrêt d'urgence à tout moment : **⌃⎋** (Ctrl + Échap). Les sites bancaires, de paiement et de
mots de passe, les champs de mot de passe et le Terminal ne sont jamais pilotés.

## Utilisation

```bash
jarvis daemon                  # policy scellée (production)
jarvis daemon --dev            # policy du repo non scellée ; N3 désactivé

jarvis service install --app     # jarvisd + Jarvis.app (voix + tableau de bord) au démarrage
jarvis "qu'est-ce qui m'attend aujourd'hui ?"   # briefing : agenda + mails triés
jarvis "réponds à Paul que je valide le devis"  # brouillon → tu confirmes → envoyé
jarvis "compare Tauri et Electron pour notre HUD"   # recherche web sourcée
jarvis "résume-moi cette vidéo https://youtu.be/arj7oStGLkU"   # via les sous-titres
jarvis "qu'est-ce qui m'attend sur GitHub ?"    # PR à relire, mes PR (CI, relectures), issues
jarvis "résume-moi la PR 7 de acme/app"           # diff expliqué en mots simples
jarvis "ajoute le mode sombre à BrightkyEfoo/codevault"   # un worker code, teste, ouvre la PR
jarvis workers                 # tâches des workers : en file, en cours, PR ouvertes
jarvis "prends mes cartes Trello"                 # cartes « jarvis » → workers → PR → carte à relire
jarvis "quelle heure est-il ?"
jarvis "ouvre VS Code sur le projet CodeVault"
jarvis "sur GitHub, ouvre la PR #7 de CodeVault et résume les commentaires"   # pilote Arc
jarvis "ajoute à mes notes les points de la réunion"                         # Notes
jarvis "dans WhatsApp, prépare un message pour Paul : j'arrive à 15 h"        # n'importe quelle app
jarvis "plan the next sprint"   # Opus pour la planification, Sonnet sinon ; FR ou EN
jarvis costs week              # consommation (équivalent API) et quota de l'abonnement
jarvis memory                  # ce que Jarvis retient · `jarvis memory notes` pour tes notes
jarvis dashboard               # tableau de bord : activité, validations, coûts, prévisions
jarvis voice                   # maintiens ⌥Espace et parle ; réappuie pour couper la parole
#                                ou, sans clavier : « Jarvis, … » (mains libres)
jarvis voice selftest          # vérifie la reconnaissance FR/EN et la voix, sans micro
jarvis voice samples           # écoute les voix neuronales (FR/EN) et choisis dans le tableau de bord
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
- `apps/mac` : Jarvis.app native Swift (barre de menus, tableau de bord, voix push-to-talk) ;
- `packages/policy` : permissions, gate, shell ;
- `packages/audit` : journal ;
- `packages/secrets` : Trousseau et rédaction ;
- `packages/memory` : mémoire (notes Markdown, faits FTS5, usage) ;
- `packages/connectors` : Gmail, Agenda, IMAP/SMTP ;
- `config/` : policy d'exemple ;
- `ops/scripts/` : scellement ;
- `tests/{e2e,redteam,perf}`.

---

*fait avec ❤️ par [Brightky Efo'o](https://brightkyefoo.cm)*
