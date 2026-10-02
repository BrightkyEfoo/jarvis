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

## Mémoire, liens et macOS (S2)

- **Empoisonnement de la mémoire** :
  - après du contenu externe, `memory_remember` passe en N2 et le fait est marqué `external` ;
  - les faits `external` ne reviennent jamais dans le prompt système, seulement via
    `memory_search`, encadrés, et ils re-teintent la session ;
  - les notes Markdown de Brightky sont hors d'atteinte des outils fichiers.
- **Exfiltration par lien** : `url_open` n'accepte que http(s). Un lien trouvé dans du contenu
  externe passe en N2 et apparaît dans l'écran de validation.
- **Apps qui exécutent** (Terminal, iTerm, Script Editor, Automator, Installer, Réglages…) : N3
  seules, N4 avec un document.
- **Raccourcis** : tout nom qui évoque de l'argent est N4 codé en dur. Un raccourci absent de la
  politique est N3.

## Voix (S3)

- **Reconnaissance** : strictement locale (`requiresOnDeviceRecognition`). Aucun audio n'est
  envoyé à Apple ni ailleurs.
- **Micro** : ouvert uniquement pendant l'appui sur le raccourci. L'indicateur orange de macOS le
  confirme.
- **Canal** : l'app vocale est un client du socket, comme la CLI. Elle ne contourne rien : chaque
  action passe par le gate.
- **Validations** : les validations N2 et N3 ne se font **pas encore à la voix**. Jarvis annonce la
  demande et renvoie vers `jarvis approvals` ; la confirmation vocale N2 arrive au S4, et le PIN ne
  sera jamais prononcé à voix haute.

## Mails et agenda (S4)

- **Lecture en quarantaine** : le contenu d'un mail n'atteint l'orchestrateur que sous forme de
  résumé.
  - Ce résumé est produit par une requête **sans outil** et validé par schéma. L'identité de
    l'expéditeur vient du serveur.
  - Les tentatives de manipulation sont signalées, et la session reste teintée (N2 toujours
    confirmé, N3 refusé).
- **Envoi** : toujours N2. Le contenu approuvé est vérifié par empreinte au moment de l'envoi. Un
  destinataire trouvé dans un mail est signalé à voix haute et à l'écran.
- **Identifiants** :
  - le refresh token Google et les mots de passe IMAP sont dans le Trousseau, et enregistrés
    auprès du redacteur ;
  - l'access token Google ne vit qu'en mémoire.
- **Scopes Google minimaux** : la lecture d'agenda reste en lecture seule. `gmail.compose`
  permettrait d'envoyer, mais l'envoi n'est accessible qu'à travers `mail_send` (N2).
- **TLS des serveurs IMAP** : jamais désactivé. Un certificat auto-signé doit être épinglé
  explicitement dans la politique scellée.
- **Confirmations vocales** : N2 seulement. Le serveur refuse le canal `voice` pour toute action qui
  demande le PIN.
- **launchd** : agents utilisateur (jamais root), environnement minimal, Node en chemin absolu.

## Recherche web et YouTube

- **Agent de recherche** : il ne dispose que de `WebSearch` (et `StructuredOutput`), surface
  vérifiée à chaque `init`. Tout autre outil déclenche STOP. Sa sortie est validée par schéma ;
  les sources non http(s) sont rejetées.
- **YouTube** : seul un id de 11 caractères est accepté, et l'URL est reconstruite par Jarvis.
  yt-dlp est lancé sans shell, avec un environnement minimal et les sous-titres seulement. La
  transcription est lue sans aucun outil.
- **Données externes** : tout ce qui vient du web est encadré et teinte la session (N2 toujours
  confirmé, N3 refusé, liens externes en N2).

## Tableau de bord

- **Accès** : c'est un client du socket comme la CLI (socket en 0600). Il passe par les mêmes
  commandes et les mêmes contrôles, sur le canal `hud`, qui est journalisé.
- **Ce qu'il permet** :
  - STOP ;
  - la reprise et les validations N3 **avec le PIN** ;
  - les validations N2 en un clic.

  Il ne peut **pas** modifier la politique : elle reste scellée et root.
- **Signature locale** : le trousseau dédié `signing/` contient seulement une identité de
  signature auto-signée, qui sert à stabiliser l'identité TCC de l'app. Son mot de passe est
  aléatoire, et ce n'est pas celui de Brightky.

## Workers Claude Code (S6)

- **Fichiers** : le worker ne lit et n'écrit que son worktree. Hook PreToolUse côté daemon,
  realpath, chaque refus audité.
- **Bash** : il tourne dans la sandbox macOS de Claude Code.
  - Écriture : worktree, tmp et cache de paquets seulement.
  - Réseau : registres de paquets seulement.
  - Lecture interdite : clés SSH, comptes cloud, `~/.npmrc`, Trousseaux, cookies et données de
    Jarvis.
- **Commandes toujours refusées** : publication (`git push/remote/config`, `npm publish`, `gh`),
  clients réseau, accès distants, élévation de privilèges, Trousseau.
- **Ne partent jamais** : configuration CI (`.github/workflows`, `.gitlab-ci.yml`), `.env*`,
  clés, secrets détectés dans le diff.
- **Identité** : commit unique au nom de Brightky, sans trailer ni mention IA. Push sur
  `jarvis/*` uniquement, PR ouverte, **jamais de merge**.
- **Token git** : il passe par un helper d'identifiants à usage unique, jamais dans une URL, dans
  `.git/config` ou dans un message d'erreur.
- **Paramètres d'un dépôt** : ceux de `.claude/settings.json` sont ignorés (`settingSources: []`),
  sinon un dépôt pourrait installer ses propres hooks ou une clé API.

## Forges (GitHub, GitLab, Trello)

- **Tokens**
  - Ils sont dans le Trousseau. GitHub utilise un token *fine-grained* sans Administration,
    Secrets ni Workflows.
  - Ils voyagent uniquement dans des en-têtes, jamais dans une URL ni dans un message d'erreur.
  - Ils sont enregistrés dans le rédacteur au démarrage.
- **Appels** : délai d'expiration, hôte limité à la base de l'API, https obligatoire pour
  GitLab.
- **Entrées** : dépôts et identifiants validés ; segments `.` et `..` refusés.
- **Contenu** : tout ce qui vient des forges (PR, diffs, issues, cartes) est une donnée externe.
  Il est encadré et teinte la session.
- **Actions au nom de Brightky** : commenter et déplacer une carte sont N2. L'auto-approbation
  par dépôt est possible, jamais après un contenu externe.
- **Merge** : jamais automatique (ADR-023).

## Pilotage du Mac (navigateur, apps, écran)

- **Qui tient les autorisations** : Jarvis.app seule (Accessibilité, Enregistrement de l'écran,
  Automatisation). Jamais `node` : une autorisation TCC donnée à Node vaudrait pour tout script
  Node de la machine.
- **Pas de code venu de l'extérieur** :
  - l'app exécute un catalogue fixe de scripts ;
  - les valeurs passent en argv à `osascript`, jamais interpolées dans une source ;
  - le JS injecté dans les pages est une constante de l'app.
- **N4 dans le code** :
  - sites bancaires, de paiement, de mots de passe, de sécurité de compte ;
  - boutons de paiement ;
  - champs mot de passe, code ou carte ;
  - Terminal et équivalents, Réglages, Trousseau, gestionnaires de mots de passe, Jarvis ;
  - touches qui font sortir de l'app (⌘Espace, ⌘Tab…).

  La politique peut seulement allonger ces listes.
- **Le réel décide** :
  - le niveau d'un clic vient du libellé réel de l'élément (empreinte revérifiée dans la page,
    sonde d'accessibilité à l'écran) ;
  - `commit: true` ne peut qu'élever le niveau ;
  - un « Envoyer » non déclaré est refusé.
- **Liste blanche** (`commit_allow_*`, vide par défaut) : elle dispense de confirmation l'envoi
  et la publication, jamais la suppression, le merge, l'approbation ni le paiement.
- **Taint** : tout affichage (page, capture, note) teinte la session. Ensuite, N3 est refusé et
  N2 exige un humain.
- **Captures** : envoyées au modèle, jamais écrites dans l'audit (empreinte et taille seulement).
  Les apps interdites ne sont jamais capturées.
- **Défense en profondeur** : l'app refuse d'elle-même les apps interdites (par identifiant de
  bundle), les sites bancaires et d'identité, la frappe dans un champ sécurisé et les touches
  système, même sur ordre du daemon.
- **Arrêt** : ⌃⎋ global, STOP du daemon (`actuate_cancel` tue l'`osascript` en cours). Une seule
  connexion peut répondre aux actions : celle qui s'est enregistrée. Les boutons STOP de l'app
  demandent deux clics, pour éviter un arrêt par erreur (la reprise exige le PIN). ⌃⎋ reste
  immédiat. La raison enregistrée dit d'où vient l'arrêt.

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
| R3 | N1 + runners autorisés (`pnpm test`, `pnpm run`) = exécution locale du code du workspace sans approbation | Workspace confiné à `~/jarvis-work`, env sans secrets ; **les workers (S6) tournent dans la sandbox macOS** (écriture et réseau limités) | S12 : même sandbox pour `shell_run` |
| R4 | TOCTOU entre la vérification d'un chemin et son usage | Nouvelle vérification à l'exécution, `O_NOFOLLOW` sur le dernier composant | Ouverture relative par descripteur de dossier (S12) |
| R5 | Ambiguïté des conditions d'Anthropic : Agent SDK sur abonnement pour un agent perso | Usage individuel, adaptateur d'auth prévu | Surveiller la page *legal-and-compliance* |
| R6 | La rédaction reste imparfaite pour des formats de secrets inconnus | La vraie défense est que les fichiers secrets sont illisibles (N4) | Élargir les motifs au fil des intégrations |
| R7 | Un process malveillant sous ton utilisateur peut modifier le plist launchd ou l'environnement (S4) | Hors modèle de menace : c'est une machine déjà compromise | Utilisateur dédié (réévaluation au S12) |
| R8 | `NODE_TLS_REJECT_UNAUTHORIZED=0` est présent dans l'environnement de lancement de VS Code | jarvisd et `pnpm install` refusent de démarrer | **Brightky** : trouver et retirer la source |
| R9 | Taint grossier au niveau de la session | Choix délibéré de sécurité | Lecteur en quarantaine (S4 et S5) |
| R10 | Un process local qui usurperait le socket du daemon pourrait commander l'actionneur de Jarvis.app (et ses autorisations TCC) | Catalogue fixe, refus intégrés à l'app, dossier `run/` en 0700 | S12 : l'app vérifie la signature du pair (`LOCAL_PEERPID` + code signing) |
| R11 | Sur un domaine en liste blanche, une page piégée peut obtenir un « Commenter » sans confirmation | Liste vide par défaut ; destructions et paiements jamais dispensés | Choix de Brightky, à garder court |
| R12 | Une capture d'écran peut montrer des données sensibles affichées dans une app autorisée | Apps sensibles exclues, captures hors audit | Masquage des zones sensibles (plus tard) |
| R13 | Mains libres : quelqu'un dans la pièce, une vidéo ou la télé peut dire « Jarvis, … » | Le nom doit ouvrir la phrase ; N2 demande un « oui », N3 jamais à la voix, N4 interdit ; ⌃⎋ STOP ; mode désactivable | Reconnaissance de la voix de Brightky (S11) |

## Signaler un problème

Repo privé. Les problèmes de sécurité sont notés ici et dans `docs/CHANGELOG.md`. Ne jamais
montrer de token, de log brut, de mail ou de message de vraie personne dans une démo publique.
