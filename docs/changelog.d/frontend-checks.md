# Vérification de l'interface par les workers (proposition 13)

Fragment à fusionner dans `docs/CHANGELOG.md`, `docs/SECURITY.md` et `docs/DECISIONS.md`.

## CHANGELOG

### Ajouté
- **Vérification de l'interface par les workers** (`workers.ui_checks`, **désactivée par
  défaut**). Quand elle est activée dans la politique scellée et que le dépôt de la tâche est un
  frontend web (React, Next.js, Vite, Storybook, détecté dans les `package.json`) :
  - le worker lance le serveur de dev sur `127.0.0.1`, sur un des ports autorisés (3000, 5173 et
    6006 par défaut) ;
  - il prend des captures avec le **Google Chrome du Mac**, sans interface, avec un profil jetable,
    à 375, 768 et 1280 px. Il peut ensuite les regarder et corriger ce qui ne va pas ;
  - Lighthouse, axe et Playwright ne tournent que **si le projet en dépend déjà**. **Rien n'est
    téléchargé** : ni navigateur Playwright, ni outil lancé par `npx` ou `dlx` ;
  - ce qui manque (Chrome, Lighthouse, axe) est dit en français dans la PR.
- **Section « Interface vérifiée » dans la PR** : un tableau pages × largeurs, les scores
  Lighthouse (performance, accessibilité, bonnes pratiques, SEO), le résultat d'axe et des tests
  Playwright, puis ce qui n'était pas disponible.
- **Les captures comptent dans la preuve** : `proof.ts` reconnaît les captures de Chrome sans
  interface, Lighthouse, axe et `playwright test`.
  - Une capture n'est verte que si Chrome a réussi **et** qu'un vrai PNG est apparu dans le dossier
    de la tâche ; sinon, la PR passe en brouillon.
  - Dans « Vérifié par Jarvis », les captures tiennent en une ligne (« captures d'écran : 6/6
    produites »).
- **Les captures restent hors du dépôt**, à côté du journal de la tâche
  (`logs/workers/<id>-ui/`). Les dossiers `test-results/`, `playwright-report/` et
  `.lighthouseci/` sont retirés du commit. Le dossier de travail de la tâche (profil Chrome,
  rapports) est supprimé à la fin.
- Tests : détection, règles du garde-fou (activé et désactivé), sandbox, preuve, section de PR, et
  un e2e sur un vrai git avec un faux worker. Chrome n'est jamais lancé en test.

## SECURITY

À ajouter à la section « Workers Claude Code (S6) » :

- **Vérification de l'interface** (ADR-036), désactivée par défaut et scellée dans la politique.
  Elle ne s'active que pour un dépôt détecté comme frontend web. Désactivée, ou sur un autre dépôt,
  le worker est **exactement** celui du S6 : mêmes outils, mêmes règles, même sandbox, même
  garde-fou. Aucun serveur MCP n'est ajouté.
- **Sandbox, quand elle est activée** : `allowLocalBinding: true` (le serveur de dev doit
  écouter), écriture dans le dossier de la tâche, lecture interdite des profils de Chrome, Arc,
  Brave et Edge. `allowedDomains` ne change pas, et les sockets Unix restent fermées : le socket
  de jarvisd reste hors d'atteinte.
- **Risque résiduel : la boucle locale n'est pas filtrée par port.** Le SDK ne propose qu'un
  booléen, `allowLocalBinding`. Il ouvre en bloc `network-bind` et `network-inbound` sur `*:*`, et
  `network-outbound` vers `localhost:*`, à **toutes** les commandes de la tâche (vérifié dans le
  profil Seatbelt généré par Claude Code 2.1.285).
  - Le suffixe `:port` des `allowedDomains` ne joue que sur le proxy, que le trafic local ne
    traverse pas (`NO_PROXY=localhost,127.0.0.1,::1`).
  - Pendant une telle tâche, du code du dépôt peut donc joindre **tout service qui écoute sur
    127.0.0.1** : bases de données, un `node --inspect` (exécution de code hors sandbox), un Chrome
    avec `--remote-debugging-port`, des serveurs de modèles locaux, le serveur de dev d'un autre
    worker.
  - **À faire par Brightky** : couper ces services avant d'activer l'option, ou la laisser
    désactivée.
- **Risque résiduel : le réseau local.** Un serveur de dev configuré sur `0.0.0.0` dans son
  fichier de config est joignable depuis le réseau local pendant la tâche. Le garde-fou refuse
  `0.0.0.0`, `::` et un `--host` seul sur la ligne de commande, mais il ne lit pas les fichiers de
  config.
- **Garde-fou, quand elle est activée** :
  - Chrome sans interface seulement (`--headless`), avec un profil jetable dans le dossier de la
    tâche ;
  - captures, PDF et rapports Lighthouse/axe écrits seulement dans ce dossier ;
  - URL limitées à `http://127.0.0.1|localhost:<port autorisé>` ;
  - refusés : `--remote-debugging-*`, `--disable-web-security`, `--load-extension`,
    `--proxy-server`, `--profile-directory` ;
  - refusés aussi : `playwright install` et tout outil d'audit absent du projet lancé par
    `npx`/`dlx`.
  - Seul ajout : `Read` peut lire le dossier de la tâche, pour que le worker regarde ses captures.
  - Ce garde-fou ne voit que la ligne de commande : un script Node peut lancer Chrome autrement. La
    vraie limite reste la sandbox, dont Chrome hérite.
- **Ports de services refusés dans la politique** (5432, 3306, 6379, 27017, 9200, 9222, 9229,
  11434, 2375, 2376) : le navigateur n'est jamais dirigé vers eux. Ce n'est pas un pare-feu.

Ligne à ajouter au tableau des risques connus :

| R14 | `workers.ui_checks` : les commandes d'une tâche frontend joignent tous les ports de 127.0.0.1 (le SDK ne filtre pas la boucle locale par port), et un serveur de dev mal configuré peut écouter sur le réseau local | Désactivé par défaut, seulement pour un frontend détecté ; garde-fou sur Chrome, les URL, les hôtes d'écoute et les téléchargements ; profils de navigateur illisibles ; ouverture inscrite au journal d'audit (`worker.ui`) | Demander un filtre par port pour `allowLocalBinding`, ou un profil `sandbox-exec` propre au serveur de dev (S12) |

## ADR

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
