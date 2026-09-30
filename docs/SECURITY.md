# Sécurité de Jarvis

> Principe : **la sécurité est garantie par le code, jamais par le prompt.** Le meilleur contrôle,
> c'est de ne pas donner l'accès : Jarvis ne possède aucun identifiant d'écriture en production.

## Niveaux d'accès

| Niveau | Nature | Règle appliquée par le code |
|---|---|---|
| N0 | Lecture | Automatique |
| N1 | Local et réversible | Automatique, journalisé |
| N2 | Parle au nom de Brightky | Confirmation. Auto-approbation seulement par règle explicite **et** en session non teintée |
| N3 | Sensible | Confirmation + PIN. **Refusé** si du contenu externe est dans la conversation, **refusé** en mode dev |
| N4 | Interdit | Bloqué dans le code (denylist non modifiable par `policy.yaml`) |

Tout ce qui n'est pas explicitement autorisé est N3. Tout ce qui ne se comprend pas (erreur de
parsing, construction shell inconnue, erreur de classification) est N4.

## Qui applique quoi

| Verrou | Où | Rôle |
|---|---|---|
| Surface minimale | `ClaudeBrain` (options SDK) | Le modèle ne voit que les 7 outils `mcp__jarvis__*`. Aucun outil intégré, aucun connecteur, rien de `~/.claude` |
| Contrôle de surface au runtime | message `init` | Un outil ou un serveur MCP étranger, ou une facturation API, déclenche STOP |
| Hook `PreToolUse` | `orchestrator/hooks.ts` | Refuse tout outil qui ne vient pas de notre serveur, et tout appel sous STOP |
| **Gate** (fait autorité) | `packages/policy/src/gate.ts` | Validation, classification, décision, approbation, audit, rédaction |
| Classification shell | `shell/parse.ts` + `shell/classify.ts` | AST, liste blanche de nœuds, règles argv, vérification des chemins en argument |
| Politique fichiers | `paths.ts` | `realpath` (anti-symlink et anti-`..`), APFS insensible à la casse, dossiers et fichiers secrets en N4 |
| Exécution | `shell/exec.ts` | Pas de shell, PATH fixe, environnement vide de secrets, groupe de process tuable |
| Scellement | `load.ts` + `seal-policy.sh` | Fichier et dossier appartenant à root, hash dans le Trousseau |

## Denylist N4 (dans le code)

- **Commandes** : `rm`, `rmdir`, `unlink`, `shred`, `sudo`, `su`, `passwd`, `dscl`, `sysadminctl`,
  `fdesetup`, `csrutil`, `spctl`, `socketfilterfw`, `pfctl`, `nvram`, `security`, `dd`, `diskutil`,
  `shutdown`…
- **Wrappers qui masquent la vraie commande** : `env`, `xargs`, `exec`, `eval`, `nohup`, `timeout`,
  `source`…
- **Code non analysable** : interpréteurs avec du code en ligne (`bash -c`, `python -c`,
  `osascript -e`…), et **tout pipe vers un interpréteur** (`curl … | sh`), `find -exec` et
  `find -delete`.
- **git** : force-push, delete ou mirror vers main/master (ou vers une cible implicite) ; options
  `-c`, `--exec-path` et `--git-dir`.
- **Fichiers** :
  - `~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.config/gh`, `~/.claude`, `~/.npmrc`, `~/.netrc`, Keychains,
    Cookies, Messages, Mail, `/etc`, `/System` et les dossiers de Jarvis ;
  - les fichiers `.env*`, `*.pem`, `*.key`, `id_*`, `credentials*` ;
  - l'écriture dans `.git/` ;
  - tout ce qui est hors des dossiers autorisés.
- **Changement de mot de passe** : N4, décision de Brightky (§9.6).

## Injection de prompt

- **Contenu externe** : il est encadré par `<external_data>` et les fausses balises sont
  neutralisées. Le prompt système dit que ce sont des données, mais **rien ne repose sur ce
  prompt**.
- **Taint de session** : dès qu'un contenu externe est entré, N3 est refusé, N2 n'est plus jamais
  auto-approuvé, et les destinations trouvées dans le contenu externe sont signalées à
  l'approbation.
- **Red team** : `tests/redteam/` joue un modèle *totalement* compromis. Critère : 0 action non
  autorisée. La suite passe à 25 cas et plus au S12.

## Zéro coût, zéro fuite de facturation

- **Environnement du sous-process** : il est construit de zéro. `ANTHROPIC_API_KEY` ne peut pas y
  entrer.
- **Source de facturation** : le daemon refuse de tourner si la source est facturée à l'API
  (`ANTHROPIC_API_KEY`, `apiKeyHelper`, `/login managed key`…).
- **Overage payant** : il déclenche STOP.

## Risques connus (à traiter)

| # | Risque | Mitigation actuelle | Plan |
|---|---|---|---|
| R1 | Un process tournant sous ton utilisateur peut parler au socket : approuver du N2, déclencher STOP | Socket 0600 ; N3 et la reprise exigent le PIN | S12 : `sandbox-exec` pour `shell_run` et les workers, vérification du PID pair |
| R2 | Les éléments du Trousseau créés par `node` sont lisibles par un autre process `node` du même utilisateur | Environnement nettoyé, préfixe `jarvis.*` | S12 : binaire signé (Node SEA) ou utilisateur dédié pour les workers |
| R3 | N1 + runners autorisés (`pnpm test`, `pnpm run`) = exécution locale du code du workspace sans approbation | Workspace confiné à `~/jarvis-work`, env sans secrets | S12 : sandbox sans réseau ni accès aux secrets |
| R4 | TOCTOU entre la vérification d'un chemin et son usage | Nouvelle vérification à l'exécution, `O_NOFOLLOW` sur le dernier composant | Ouverture relative par descripteur de dossier (S12) |
| R5 | Ambiguïté des conditions d'Anthropic : Agent SDK sur abonnement pour un agent perso | Usage individuel, adaptateur d'auth prévu | Surveiller la page *legal-and-compliance* |
| R6 | La rédaction reste imparfaite pour des formats de secrets inconnus | La vraie défense est que les fichiers secrets sont illisibles (N4) | Élargir les motifs au fil des intégrations |
| R7 | Un process malveillant sous ton utilisateur peut modifier le plist launchd ou l'environnement (S4) | Hors modèle de menace : c'est une machine déjà compromise | Utilisateur dédié (réévaluation au S12) |
| R8 | `NODE_TLS_REJECT_UNAUTHORIZED=0` est présent dans l'environnement de lancement de VS Code | jarvisd et `pnpm install` refusent de démarrer | **Brightky** : trouver et retirer la source |
| R9 | Taint grossier au niveau de la session | Choix délibéré de sécurité | Lecteur en quarantaine (S4 et S5) |

## Signaler un problème

Repo privé. Les problèmes de sécurité sont notés ici et dans `docs/CHANGELOG.md`. Ne jamais
montrer de token, de log brut, de mail ou de message de vraie personne dans une démo publique.
