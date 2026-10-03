# Changelog

## 0.17.0 — LinkedIn, community manager (03/10/2026)

### Ajouté
- **Publication sur LinkedIn par l'API officielle gratuite** (« Share on LinkedIn », OAuth local,
  `jarvis linkedin connect`). Jarvis publie **au moment où Brightky valide le texte exact** (N2),
  jamais en différé. Les caractères réservés du format LinkedIn sont échappés : le code passe tel
  quel.
- **Visuels** :
  - `linkedin_card` : citation ou extrait de code mis en carte 1080×1350 signée, rendue nativement
    par Jarvis.app (taille du code calculée pour qu'aucune ligne ne se replie) ;
  - `linkedin_screenshot` : capture d'une fenêtre (jamais d'app protégée).
  - Seuls ces visuels, ou un PDF de ses dossiers (post « document »), peuvent être joints.
- **Apprendre de ses posts** :
  - `linkedin_stats_import` lit l'export XLSX d'Analytics (sans dépendance : unzip et XML) ;
  - `linkedin_insights` compare chaque post à la médiane de ses 10 précédents, sort les tops et
    les flops, et des hypothèses sur les formats (PDF, images, liens, accroche, longueur, horaire).
- **Community management** : brouillons de réponses aux commentaires (depuis les mails de
  notification) et rappels de publication. Brightky reste celui qui poste.
- **linkedin.com interdit au pilotage du navigateur**, dans le daemon et dans Jarvis.app :
  LinkedIn interdit l'automatisation de son site.
- Guide : `docs/SETUP-LINKEDIN.md`.

## 0.16.0 — Serveurs et déploiements (03/10/2026)

### Ajouté
- **Serveurs déclarés dans la politique scellée** (`ops.servers`) : hôte, utilisateur, environnement
  (prod / staging / dev), apps avec leur commande de déploiement et de logs, ou leur webhook Coolify.
  Jarvis ne peut pas s'ajouter un serveur.
- **`server_run`** : une commande, en argv, par SSH, avec les clés ou l'agent de Brightky,
  `BatchMode` et `StrictHostKeyChecking=yes`.
  - Lectures (état, `docker ps`, `journalctl`, logs…) : directes.
  - Le reste demande le PIN en prod et une confirmation en staging / dev.
  - Jamais : `rm`, `sudo`, `curl`, shells, `prune`, `volume rm`, `down -v`, `kubectl delete`,
    `terraform destroy`, `push --force`.
- **`deploy`** : le script déclaré, ou le webhook Coolify. En prod, il faut le PIN et une
  conversation propre. **`server_logs`** : les logs déclarés.
- **Coffre** (`jarvis vault set|list|rm`) : jetons et mots de passe au Trousseau. Jarvis les utilise
  par leur nom et ne les voit jamais.
- **`repo_secret_set`** : un secret de CI (GitHub via `gh secret set` sur stdin, GitLab via l'API),
  depuis le coffre ou généré. Toujours avec le PIN.
- **`deploy_key_setup`** : branche la CI d'un dépôt sur un serveur.
  - Une clé ed25519, dont la clé publique est installée sur le serveur avec
    `restrict,command="<script de déploiement>"` : elle ne peut lancer que le déploiement.
  - Les secrets `DEPLOY_*` sur le dépôt.
  - Le workflow GitHub Actions à ajouter.
- Guide : `docs/SETUP-OPS.md`.
- Politique d'exemple : lectures ops locales sans confirmation (`kubectl describe/logs/top/events`,
  `docker ps/logs/images/stats`, `helm status/list/history`, `terraform validate`), et
  `terraform plan` en N1. Restent exclues les commandes qui affichent des secrets (`kubectl get`,
  `docker inspect`, `helm get`, `terraform show`).
- « Regarde ça » : Jarvis regarde la fenêtre au premier plan. Consignes tech lead : notes de
  version, rapport de la semaine, tri des issues à valider.

## 0.15.0 — Jarvis Island (03/10/2026)

### Ajouté
- **L'île Jarvis** : une capsule noire au centre de l'écran principal. Avec une encoche, elle en
  sort ; sans encoche, elle se place sous la barre de menus. Elle n'apparaît que lorsqu'il se passe
  quelque chose, par ordre de priorité :
  - **STOP** : champ PIN pour reprendre sur place ;
  - **validation en attente** : niveau N2 ou N3, résumé en français, avertissement « contenu
    externe », boutons Refuser / Approuver (PIN pour N3), « dis oui ou non » quand la voix demande ;
  - **Jarvis pilote une app** : point orange, et un STOP en un clic qui coupe l'action en cours ;
  - **écoute** : barres pilotées par le vrai niveau du micro et transcription en direct ;
  - **réflexion** : « Je consulte ton agenda… », selon l'outil en cours ;
  - **parole** : barres pilotées par la vraie voix de Jarvis, et la phrase prononcée ;
  - **workers en cours** : nombre, détail au clic, quota sur 5 h et 7 jours.
- Les boutons gardent leur couleur dans un panneau qui ne prend jamais le focus. Le panneau
  n'active pas Jarvis.app et ne vole pas le clavier, sauf pour un PIN.
- Réglage : Tableau de bord › Réglages › Voix › « Île Jarvis sous l'encoche » (actif par défaut).
- `--snapshot` rend aussi l'île dans ses 8 états, hors écran.
- **File de revue** (`review_queue`, N0), sur GitHub et GitLab : les PR où l'on demande ta revue,
  plus celles des workers (branches `jarvis/*`). Elles sont classées sans lire le diff :
  - l'ancienneté d'abord ;
  - puis les zones à risque, déduites des chemins : secrets, auth, migrations, CI, infra,
    dépendances, grosse PR ;
  - une CI rouge ou des changements demandés font descendre la PR (à l'auteur d'agir), une PR en
    brouillon passe en dernier ;
  - pour chaque PR : taille, CI et approbations.
- **Brief tech du matin** : la file de revue classée (avec les zones à risque), les CI rouges de
  mes PR (avec « ci_failure pour savoir pourquoi »), les changements demandés, les PR
  Dependabot/Renovate, les résultats des workers sur 24 h et le quota de l'abonnement.
- **Alerte de quota** : Jarvis le dit une fois, quand la fenêtre de 5 h ou celle de la semaine
  passe 85 %, et seulement s'il n'est pas occupé. Il le redira si elle repasse sous 70 % puis
  remonte. Les workers attendent déjà au-delà de la réserve interactive.
- **« Pourquoi la CI est rouge ? »** (`ci_failure`, N0), pour une PR ou une branche, sur GitHub et
  GitLab : les jobs en échec, leurs annotations (fichier:ligne) et la fin de leur log, nettoyée des
  couleurs et des horodatages. Jarvis explique la cause, puis propose un worker qui corrige sur la
  branche de la PR, avec une consigne qu'il rédige lui-même, jamais le log brut.
  - Le log est lu comme une donnée externe : la session est teintée, et la tâche du worker est
    encadrée comme externe.
  - L'URL signée de téléchargement des logs GitHub est suivie **sans le token**.
  - Le téléchargement est plafonné à 3 Mo (connexion mesurée) ; seule la fin du log est gardée.
- **La preuve avant la PR** : Jarvis enregistre lui-même les vérifications que le worker a vraiment
  lancées (tests, lint, typecheck, build), avec leur vrai résultat tiré des hooks du SDK, sans se fier
  au compte rendu du worker.
  - La PR affiche « Vérifié par Jarvis » : ✅ ou ❌ par commande, avec le dernier résultat de chacune.
  - Elle est ouverte en brouillon, avec un avertissement, si aucune vérification n'a tourné, si
    l'une échoue à la fin, ou si du code a été modifié après la dernière vérification.
  - L'étape de la tâche le dit (« PR ouverte, vérifiée (2 commandes au vert) »), dans le tableau
    de bord comme sur l'île.
- **Pré-revue sans bruit** : seulement les problèmes sévères, cinq au plus, avec fichier:ligne et la
  raison, jamais de pinaillage, et « rien de bloquant » si rien de grave. Un commentaire ne part
  qu'avec son texte exact validé (N2).

## 0.14.0 — Le bureau (02/10/2026)

### Ajouté
- **Voir l'écran** :
  - `screen_look {display}` capture un écran entier (1 = celui de la barre de menus), avec la
    position de chaque fenêtre ;
  - Terminal, Réglages, les gestionnaires de mots de passe et Jarvis sont exclus de l'image.
- **`windows_list`** : ce qui est ouvert et sur quel écran, y compris les apps masquées ou
  réduites.
- **Fermer des apps** : `app_quit`, comme ⌘Q, sans jamais forcer. Une seule validation pour toute
  la liste (« ferme les apps du premier écran »). Une app qui demande d'enregistrer reste ouverte,
  et Jarvis le dit.
- **Ranger les fenêtres** : `window_manage` met une fenêtre au premier plan, la masque, la réduit,
  la passe en plein écran ou l'agrandit. Il la range aussi sur une moitié de l'écran ou au centre,
  et peut la déplacer sur un autre écran. Fermer une fenêtre demande une validation.
- Jarvis.app 0.8.0 : nouvelle capacité `windows`. Les nouvelles actions sont traduites en français
  pour la voix et le tableau de bord.
- **Encore plus de façons d'appeler Jarvis** :
  - toute courte entrée en matière suffit avant le nom : « Bon, / Allez / Tiens / Au fait / Du
    coup / Dis donc / Bref / Vas-y / S'il te plaît / Franchement… Jarvis » ;
  - en anglais : « So / Well / Alright / Listen / By the way… Jarvis » ;
  - un vrai mot avant le nom fait partie de la demande : « Ouvre, Jarvis, le terminal ».
  - Les phrases qui parlent *de* Jarvis ne le déclenchent pas : « Jarvis est lent », « le projet
    Jarvis », « Jarvis m'a dit ».
  - Si la reconnaissance coupe le nom en deux (« Jar vis »), il est recollé.
  - Mesure sur 63 phrases dites par des voix de synthèse : 47 déclenchements sur 55 attendus, contre
    environ 25 avant, et aucun faux déclenchement. Les ratés restants viennent tous de la voix la
    plus robotique, où le nom n'est pas transcrit du tout.

## 0.13.0 — Tout connecter, appel plus naturel (02/10/2026)

### Corrigé
- **STOP accidentel** : le bouton STOP de la barre de menus, juste au-dessus de « Quitter »,
  arrêtait Jarvis en un clic, et la reprise demande le PIN.
  - Il faut maintenant deux clics en 4 s (« STOP » puis « Confirmer STOP »). Même chose dans le
    tableau de bord, qui perd au passage le raccourci ⌘. (souvent tapé pour « annuler »).
  - ⌃⎋ reste une seule touche.
  - La raison indique la source (barre de menus, tableau de bord, ⌃⎋) dans l'audit et sur la
    bannière.
- **Reprendre sans chercher de fenêtre** : le PIN se tape directement dans le menu Jarvis quand
  STOP est enclenché. Le tableau de bord pouvait s'ouvrir hors de l'écran visible (autre bureau,
  derrière l'app active) : il est maintenant ramené devant.
- **Jarvis à l'arrêt** : il dit maintenant comment reprendre (icône Jarvis, PIN). Après
  une réponse d'erreur, il n'ouvre plus de fenêtre d'écoute sans le nom. Avant, le bruit de la
  pièce y entrait et recevait la même erreur, en boucle.

### Ajouté (suite)
- **Plusieurs comptes Gmail perso** :
  - `jarvis google connect` laisse choisir le compte et détecte l'adresse autorisée ;
  - il ajoute le compte à la politique et la re-scelle ;
  - on peut le relancer pour chaque compte, et `jarvis setup` propose « un autre compte Gmail ».
- **Agenda** : les agendas de tous les comptes connectés sont fusionnés. Une réunion partagée
  entre deux comptes n'apparaît qu'une fois, et un compte en panne ne masque pas les autres.

### Ajouté
- **`jarvis setup`** : connecte pas à pas GitHub (perso et chaque organisation), GitLab,
  Trello, Gmail et Agenda, le mail pro et Teams.
  - Les pages s'ouvrent pré-remplies : token GitHub fine-grained à droits minimaux, token GitLab.
  - Chaque token est vérifié avant d'être enregistré.
  - Le mail pro est testé en IMAP et SMTP, puis ajouté à la politique et scellé.
  - Jarvis est redémarré à la fin.
- **GitHub, un token par propriétaire** : un token fine-grained ne couvre qu'un compte ou une
  organisation. Jarvis choisit le bon token pour chaque dépôt, et pour pousser les branches des
  workers. La boîte de réception interroge tous les tokens.
- **Politique personnelle** dans `config/policy.yaml`, exclue de git. L'exemple du dépôt reste
  générique.
- **Appel plus naturel** :
  - « Hello / Bonjour / Bonsoir / Salut / Excuse-moi… Jarvis, … » ;
  - le nom en fin de phrase (« Quelle heure est-il, Jarvis ? ») ;
  - le nom entre virgules (« Alors, Jarvis, … »).

  Une simple mention (« c'est Jarvis qui… », « parlé à Jarvis ») est ignorée.
- **Teams** : piloté comme les autres apps (pas d'API Microsoft nécessaire). L'envoi est
  confirmé, sauf si `setup` l'autorise sans confirmation.
- **Tests** : 12 tests Swift (variantes d'appel), 3 tests TS (liens d'installation, un token
  par propriétaire).

## 0.12.0 — Mains libres, signature stable (02/10/2026)

### Ajouté (suite)
- **Conversation continue** : après une réponse, Jarvis écoute encore 10 s sans qu'il faille
  redire son nom. Son propre écho dans la pièce est reconnu et ignoré.
- **Un simple appui sur ⌥Espace** : tu tapes la touche sans la maintenir, et la fin de phrase
  est détectée automatiquement. Maintenir la touche fonctionne toujours.

### Ajouté
- **« Jarvis, … » sans toucher le clavier** (ADR-029) : détection de parole Silero + Parakeet, le
  tout local. Le nom doit venir en premier. « Jarvis » seul réveille Jarvis, et « oui » / « non »
  suffisent pendant une confirmation.
- **Réglage** : interrupteur « Mains libres » dans Réglages › Voix (`wake` dans `voice.json`).
- **Outils de diagnostic** : `--wake-test` passe des fichiers audio dans la chaîne mains libres.
- **Tests** : 8 tests Swift du mot d'éveil.

### Corrigé
- **Saisie des tokens et mots de passe** : affichage de •, collage multi-lignes et entre
  crochets, lecture du presse-papiers (`jarvis auth set-token`).
- **Signature locale** : `codesign` ne trouvait pas l'identité si son trousseau n'était pas dans
  la liste de recherche. `build.sh` l'y ajoute le temps de la signature, puis remet la liste de
  Brightky à l'identique.
- **Voix neuronales** : la bascule se fait au premier moment de repos.

## 0.11.0 — S7 : de Trello aux workers, en parallèle (02/10/2026)

### Ajouté
- **`trello_take`** (ADR-028) : les cartes étiquetées `jarvis` partent chez des workers, avec une
  seule validation pour le lot. Chaque carte passe en « En cours » ; à la fin, elle reçoit le lien
  de la PR et passe en « À relire ».
- **Dépôt d'une carte** : ligne `repo: owner/repo` dans la carte, ou correspondance
  `forges.trello_boards`. Noms des colonnes réglables.
- **Parallélisme** : 2 workers par défaut. Un verrou par dépôt sérialise les opérations git
  partagées.
- **Tests** : 3 tests e2e (lot Trello, carte sans dépôt, 2 workers en parallèle), 2 tests de
  correspondance carte → dépôt et 1 test Swift.

### Corrigé
- **Course entre deux workers** sur le même dépôt (clone et fetch simultanés), trouvée par le
  test de parallélisme.

## 0.10.0 — S6 : workers Claude Code (02/10/2026)

### Ajouté
- **Workers** (ADR-027). File SQLite → clone partiel de Jarvis → worktree → Claude Code (Agent
  SDK, abonnement) → vérifications → commit unique au nom de Brightky → branche `jarvis/…` → PR.
- **Sécurité** :
  - hook PreToolUse qui limite les fichiers et les commandes au worktree ;
  - sandbox macOS pour Bash (écriture limitée, réseau réservé aux registres) ;
  - aucun fichier CI ni secret ne part ;
  - aucune mention IA dans les commits et les PR ;
  - push uniquement sur `jarvis/*`, jamais de merge.
- **Outils** : `worker_start` (N1), `worker_status`, `worker_cancel`, `worker_log`.
- **CLI** : `jarvis workers`. **Tableau de bord** : carte Workers, activité en direct.
- **Forges** : ouverture de PR (GitHub) et de MR (GitLab), informations sur le dépôt.
- **Politique** : section `workers` (parallélisme, modèle, plafonds, brouillon, dossier, réseau).
- **Tests** : 8 tests du garde-fou, 6 tests e2e sur un vrai git et 1 test Swift.

## 0.9.0 — S5 : GitHub, GitLab et Trello (02/10/2026)

### Ajouté
- **Clients** GitHub, GitLab (gitlab.com ou auto-hébergé) et Trello. Tokens dans le Trousseau,
  transmis uniquement dans les en-têtes (ADR-026).
- **Outils** :
  - `forge_inbox` : PR à relire, mes PR avec CI et relectures, issues assignées ;
  - `pr_list`, `pr_read` (diff dans un budget, discussion), `issue_list`, `issue_read` ;
  - `forge_comment` (N2) ;
  - `trello_boards`, `trello_lists`, `trello_cards` (dont le filtre par étiquette),
    `trello_card`, `trello_comment` (N2), `trello_move` (N2).
- **Briefing du matin** : section Code (GitHub, GitLab, Trello).
- **CLI** : `jarvis github connect`, `jarvis gitlab connect [url]`, `jarvis trello connect` ;
  guide dans `docs/SETUP-FORGES.md`.
- **Tableau de bord** : section « Code et tâches » dans Comptes ; résumés traduits en français.
- **Politique** : section `forges` (`gitlab_url`, `max_diff_chars`, `trello_label`).
- **Tests** : 8 tests de clients (fausse API : en-têtes, chemins, pagination, budget de diff,
  noms invalides), 7 tests e2e (boîte de réception, injection dans une PR, commentaire validé,
  Trello, briefing) et 3 tests Swift.

### Sécurité
- Les noms de dépôts contenant `.` ou `..` sont refusés : le test l'a révélé avant la mise en
  service.

## 0.8.0 — Voix neuronales locales (02/10/2026)

### Ajouté
- **Reconnaissance Parakeet v3** (CoreML, locale) : français et anglais en un seul passage,
  94 à 133 ms par phrase.
- **Voix PocketTTS** en streaming (ADR-025) :
  - 4 voix françaises masculines (Fabien, Théo, Samuel, Erick) issues de dons de voix (CC0) ;
  - 7 voix anglaises masculines (Charles, Javert, Michael, Peter, Jean, Paul, George) ;
  - Estelle et Alba au féminin.
- **Bascule automatique** des voix Apple vers les voix neuronales dès qu'elles sont chargées ;
  préchauffage, lecture continue avec 240 ms de tampon, regroupement des phrases.
- **Tableau de bord** : choix des voix FR et EN, écoute des échantillons, moteur en cours.
- **CLI** : `jarvis voice samples`, qui génère un échantillon de chaque voix dans `~/Jarvis/voix`
  avec latence, vitesse et taux d'erreur.
- **Jarvis.app** : `--voice-lab`, `--voice-session`, `--voice-screen`, `--neural-selftest`.
  L'option `JARVIS_MUTE=1` sert aux tests silencieux.
- « Brightky » est réécrit phonétiquement pour la synthèse ; les symboles (%, €, FCFA) sont
  prononcés.
- **Tests** : 5 tests Swift (texte parlé, taux d'erreur).

### Modifié
- Jarvis.app devient un paquet Swift (FluidAudio 0.17.5 épinglé). `build.sh` copie les
  ressources et les extraits de voix dans l'app.

## 0.7.0 — Pilotage du Mac (01/10/2026)

### Ajouté
- **Jarvis pilote le Mac quand il n'y a pas d'API** (ADR-024), via Jarvis.app, seule détentrice
  des autorisations macOS :
  - **navigateur** (profil principal Arc ou Chrome) : `browser_tabs`, `browser_open`,
    `browser_read` (texte et éléments numérotés), `browser_click`, `browser_fill`,
    `browser_back` ;
  - **Notes** : `notes_list`, `notes_read`, `notes_create`, `notes_append` ;
  - **Rappels** : `reminders_list`, `reminders_add`, `reminders_complete` ;
  - **n'importe quelle app** : `screen_look` (capture + contrôles numérotés), `screen_act`
    (clic, double-clic, frappe, touche, défilement).
- **Pont d'actionneur** entre le daemon et l'app (`actuator_register`, `actuate`,
  `actuator_result`, `actuate_cancel`), lignes jusqu'à 16 Mio pour les captures.
- **Gate** : les outils peuvent renvoyer des images (seule leur empreinte va dans l'audit) et
  lever un `Refusal` quand l'état réel (page, élément sous le pointeur) l'exige.
- **Politique** : section `computer` (navigateur, `commit_allow_domains`, `commit_allow_apps`,
  domaines et apps interdits en plus des listes intégrées).
- **Arrêt d'urgence ⌃⎋**, global ; indicateur « Jarvis pilote … » dans la barre de menus ;
  état des « mains » dans les réglages du tableau de bord ; `jarvis status` affiche l'actionneur.
- **Tests** : 16 e2e avec un faux Jarvis.app sur le vrai socket, 7 du pont, 95 cas de règles
  (sites, apps, libellés, touches, champs secrets), 17 tests Swift (garde-fous, libellés FR).

### Modifié
- `HotKey` gère plusieurs raccourcis (voix et STOP).

## 0.6.0 — Tableau de bord Jarvis.app (S8 avancé) (01/10/2026)

### Ajouté
- **Jarvis.app** (SwiftUI natif, 1,2 Mo) : icône de barre de menus et panneau rapide, tableau de
  bord en 8 sections (vue d'ensemble, activité, validations, coûts et quota, prévisions,
  mémoire, comptes, réglages), voix intégrée.
- **Daemon** : `dashboard` (instantané), `watch` (événements en direct), `audit_query`,
  `upcoming` ; canal de validation `hud` ; échantillons de quota et prévisions de saturation ;
  consommation par jour.
- L'audit inclut désormais le résumé de l'action dans les lignes « résultat » et
  « validation », et la raison dans les refus.
- **CLI** : `jarvis dashboard`, `jarvis service install --app`.
- `apps/mac/signing-setup.sh` : signature locale stable, donc plus de permissions redemandées à
  chaque compilation.
- `--snapshot` : rendu des écrans avec des données de démo, pour la revue visuelle.
- **Tests** : 5 tests e2e du tableau de bord (instantané, flux en direct, historique filtré,
  prévisions) et 4 tests de libellés.

### Modifié
- `apps/voice` devient `apps/mac` (Jarvis.app, bundle `cm.brightkyefoo.jarvis`, macOS 15+).
- Les résumés d'actions sont traduits en français par une table commune à la voix et à
  l'interface.

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
