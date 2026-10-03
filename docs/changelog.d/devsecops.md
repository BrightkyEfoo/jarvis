# Kit DevSecOps : scanners locaux, triés par Jarvis

Fragment à fusionner dans `docs/CHANGELOG.md`, `docs/SECURITY.md` et `docs/DECISIONS.md`
(rapport « Jarvis pour les équipes tech », propositions 8, 9 et 10).

## CHANGELOG

### Ajouté
- **`security_tools` (N0)** : quels scanners sont installés (chemin, version) et comment installer
  les autres, avec la commande Homebrew et la taille approximative du téléchargement. Les gros
  (checkov, semgrep, bases de trivy et grype) sont signalés « sur Wi-Fi ». Catalogue : gitleaks,
  osv-scanner, zizmor, checkov, trivy, grype, syft, opengrep, semgrep. Les binaires sont cherchés
  dans `/opt/homebrew/bin`, `/usr/local/bin`, `~/.local/bin`, puis le PATH (entrées absolues
  seulement).
  - Une version compromise connue (trivy 0.69.4 à 0.69.6, attaque TeamPCP de mars 2026) est
    signalée. Pour une installation Homebrew, la version est lue dans le chemin du Cellar, sans
    lancer le binaire.
- **`security_scan` (N0, contenu externe)** sur un dossier de projet :
  - `secrets` : gitleaks (`--redact`) ;
  - `dependencies` : osv-scanner, avec la version corrigée qui s'applique à la version installée ;
  - `ci` : zizmor pour GitHub Actions, checkov (`gitlab_ci`) pour GitLab CI ;
  - `iac` : checkov (Terraform, CloudFormation, Kubernetes, Dockerfile, Serverless, ARM, Bicep,
    Ansible), trivy en secours ;
  - `image` (sur demande, paramètre `image`) : trivy, sinon grype ;
  - `sast` : opengrep, sinon semgrep, **seulement avec un jeu de règles local** (`.semgrep.yml`,
    `.semgrep/`, `.opengrep.yml`). Jamais de règles téléchargées.

  Les rapports JSON sont ramenés à une forme commune : outil, gravité, règle, fichier:ligne,
  message court, correctif. Le résumé en français est trié par gravité, puis par les signaux
  d'atteignabilité et d'exposition quand le scanner les donne :
  - vulnérabilité appelée ou non par le code (analyse d'appels d'osv-scanner) ;
  - dépendance de dev seulement ;
  - exploitation active (CISA KEV, via grype) ;
  - audit atteignable par un attaquant extérieur (injection de template, déclencheurs dangereux) ;
  - accès public dans l'IaC.

  Il est plafonné (40 lignes, 8 000 caractères ; le reste est compté) et dit ce qui a tourné, ce
  qui manque, et ce qui est parti sur le réseau.
- `offline: true` : osv-scanner `--offline`, trivy `--skip-db-update --skip-java-db-update
  --offline-scan`, grype `GRYPE_DB_AUTO_UPDATE=false`. Les bases doivent avoir été téléchargées
  avant (sur Wi-Fi).
- **PR des workers** (sans réseau, sans installation) :
  - **Nouvelles dépendances** : lues dans les manifestes avant et après (`package.json`,
    `requirements*.txt`, `go.mod`). Sont signalés en tête de PR :
    - une source hors registre (git, URL, fichier, raccourci GitHub) ;
    - un alias npm ;
    - une version non bornée (`*`, `latest`, `>=x`) ;
    - un nom très proche d'un paquet populaire (typosquatting) ;
    - une dépendance npm absente du lockfile, donc jamais installée (nom inventé ?) ;
    - un index PyPI ajouté, une installation éditable, une directive `replace` Go.

    La PR reste alors en brouillon, et l'étape le dit (« 2 dépendance(s) à vérifier »).
  - **gitleaks sur les lignes ajoutées**, si gitleaks est installé : un secret que les motifs du
    rédacteur ne connaissent pas bloque la publication. S'il manque ou s'il échoue, le pipeline
    continue avec le contrôle existant, sans attendre.
- Consigne du prompt (4 lignes) : quand utiliser `security_scan` et `security_tools`, trier et
  expliquer sans jamais recopier une valeur de secret.

### Tests
- 24 tests unitaires (`apps/jarvisd/test/security.test.ts`) contre de **faux exécutables** (scripts
  Node écrits dans un dossier temporaire, injectés par le localisateur de binaires). Ils couvrent :
  - un parseur par scanner, sur des rapports de la forme réelle ;
  - la rédaction : un faux gitleaks qui **ignore `--redact`** et renvoie le secret brut, jusque
    dans la description et le nom de fichier ; rien ne sort ;
  - le refus des chemins : lien symbolique vers `~/.ssh`, `.env.d`, hors racines, `/etc`, racine
    qui contient des identifiants, schéma d'image local ;
  - le message quand un outil manque, le délai dépassé (processus tué), les codes de sortie, une
    version compromise jamais lancée, un binaire du projet jamais lancé ;
  - les contrôles de dépendances.
- 6 tests e2e (`tests/e2e/security.test.ts`) passent par le harnais, le gate et le cerveau scripté
  (`call security_scan {…}`). Ils couvrent :
  - N0 sans validation, sortie encadrée, session teintée, aucun secret dans la sortie ni dans
    l'audit ;
  - la PR d'un worker avec dépendances suspectes (brouillon, avertissement en tête) ;
  - un secret inconnu des motifs, arrêté par gitleaks : rien n'est poussé.

## SECURITY

### Scanners de sécurité (DevSecOps)
- **Catalogue fixe** (`apps/jarvisd/src/security/catalogue.ts`) :
  - les seuls argv possibles sont écrits dans le code ; le modèle choisit le dossier, les contrôles,
    `offline` et une référence d'image validée, rien d'autre ;
  - l'exécution passe par l'exécuteur de `shell/exec.ts` : pas de shell, groupe de process tué au
    STOP ou au délai, sortie plafonnée (24 Mo par scanner), environnement reconstruit sans aucun
    secret, PATH fixe.
- **Le dossier scanné** passe par la même politique que `fs_read` (`FsPolicy.check` en lecture) :
  - realpath, donc un lien symbolique vers `~/.ssh` est refusé ;
  - dossiers protégés, fichiers `.env*` et clés, hors des racines autorisées : N4 avec la règle
    d'origine (`fs.deny.protected`, `fs.deny.secret_file`, `fs.outside_roots`) ;
  - de plus, une racine qui **contient** un magasin d'identifiants (`~/.ssh`, `~/.aws`, Trousseaux,
    données de Jarvis…) est refusée (`security.scan.contains_protected`) ;
  - le contrôle est refait à l'exécution.
- **Binaire** : un scanner situé dans le projet scanné (par exemple `node_modules/.bin`) n'est
  jamais lancé. Une version compromise connue (trivy 0.69.4 à 0.69.6) n'est jamais lancée, et sa
  version est lue dans le Cellar de Homebrew sans l'exécuter.
- **Références d'image** : nom[:tag][@sha256:…] uniquement. Les schémas qui font lire un chemin
  local (`dir:`, `file:`, `sbom:`, `oci-dir:`…) sont refusés (`security.image_scheme`). `--` est
  passé avant la référence.
- **Jamais de valeur de secret** :
  1. drapeaux des scanners (`gitleaks --redact`, trivy `--scanners vuln`, checkov sans le
     framework `secrets`) ;
  2. les parseurs ne lisent jamais `Secret`, `Match`, `Line`, `code_block` ni `extra.lines` ;
  3. une valeur brute qu'un scanner aurait laissée passer est retirée de tout le texte, avant toute
     troncature, puis le rédacteur du daemon s'applique. La sortie du gate repasse ensuite par le
     rédacteur.
- **Réseau**, toujours annoncé dans le résumé :
  - osv-scanner envoie les noms et versions des paquets à api.osv.dev, jamais le code ;
  - trivy et grype téléchargent leur base au premier scan (~60 à 80 Mo, plus ~700 Mo de base Java
    pour trivy si l'image contient des `.jar`), et l'image si elle n'est pas en local ;
  - zizmor tourne en `--offline` (aucun token GitHub n'est fourni), checkov en `--skip-download` ;
  - la SAST n'utilise que des règles locales.

  `offline: true` coupe tout appel, sauf la récupération d'une image absente du Docker local.
- **Taint** : la sortie est une donnée externe (messages de bases de vulnérabilités, de règles du
  dépôt). Elle est encadrée et teinte la session.
- **Non proposé** : la vérification en ligne des secrets (`trufflehog --verify`). Elle enverrait
  chaque secret trouvé à son fournisseur. Si elle arrive un jour, ce sera en N3.
- **PR des workers** : gitleaks sur les lignes ajoutées s'ajoute au rédacteur (il ne le remplace
  pas). Les nouvelles dépendances suspectes laissent la PR en brouillon. Aucun des deux contrôles
  n'utilise le réseau ; un outil absent ne bloque rien.
- **Risques résiduels** :
  - un lien symbolique *à l'intérieur* du projet n'est pas suivi par défaut par les scanners
    (gitleaks sans `--follow-symlinks`, parcours sans suivi des liens), mais ce n'est pas vérifié
    sur de vrais binaires. Le pire cas est un constat qui nomme un fichier, jamais son contenu ;
  - un message de règle semgrep peut interpoler du code (métavariables) ; seul le rédacteur le
    filtre ;
  - les drapeaux des CLI sont tirés de leur documentation, pas d'un binaire réel (voir ADR-035).

## ADR

### ADR-035 — Kit de scanners DevSecOps locaux (03/10/2026)

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
