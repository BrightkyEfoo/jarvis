# Figma gratuit : plugin de développement et pont local

Fragment à fusionner dans `docs/CHANGELOG.md`, `docs/SECURITY.md` et `docs/DECISIONS.md`.

## CHANGELOG

### Ajouté
- **Figma, gratuit et sans quota** : un plugin de développement (`apps/figma-plugin/`), chargé
  dans l'app desktop, relié à jarvisd par un pont local (127.0.0.1:47830, un jeton par
  démarrage). Le serveur MCP officiel est plafonné à environ 20 appels par mois sur le plan
  gratuit.
  - **Lire** (N0, la session est teintée) :
    - `figma_status` : fichier, page, sélection ;
    - `figma_read_selection` : l'arbre des calques, borné en profondeur et en taille (tailles,
      auto layout, textes, couleurs en hex, effets, variables liées, styles, propriétés de
      composants) ;
    - `figma_variables` : les variables locales en design tokens W3C (DTCG 2025.10) ;
    - `figma_export` : le PNG d'un calque, montré au modèle comme une capture ; l'audit n'en
      garde que l'empreinte.
  - **Écrire** :
    - `figma_create_frame` : un frame en auto layout, à partir d'une petite spec JSON validée
      (frames, textes, rectangles, couleurs, marges, espacements), toujours dans la page
      « Jarvis drafts » (N1) ;
    - `figma_set_text`, `figma_rename`, `figma_bind_variable`, `figma_create_component` : N1 dans
      cette page ; ailleurs, N2 avec l'avant → après exact à l'écran de validation.
  - **« Lis la maquette sélectionnée et génère le composant »** : Jarvis lit la sélection et les
    variables, puis confie le code à un worker avec la spec extraite dans la consigne.
  - Chaque action de Jarvis est une étape d'annulation dans Figma (⌘Z).
  - Mise en route : `docs/SETUP-FIGMA.md`.

### À venir
- Traduire les résumés « Figma: … » dans `Wording.swift` (tableau de bord, île, voix).
- Faire authentifier le daemon par le plugin (défi-réponse), voir le risque ci-dessous.

## SECURITY

À ajouter dans une section **Figma (plugin local)** :

- **Pont local** : il écoute sur 127.0.0.1 seulement, sur un port fixe (47830) que le manifeste du
  plugin nomme dans `devAllowedDomains`. `allowedDomains` vaut `["none"]` : le plugin n'a aucun
  accès à Internet.
- **Admission**, dans cet ordre :
  - adresse de boucle locale ;
  - Host `127.0.0.1:47830` ou `localhost:47830`, contre le DNS rebinding ;
  - Origin absente, `null` (l'iframe du plugin) ou figma.com : une page web est refusée avant
    même la lecture du jeton ;
  - POST en JSON seulement ;
  - jeton Bearer, comparé en temps constant.

  Chaque refus est audité, au plus une fois par minute et par raison.
- **Jeton** : 256 bits aléatoires, un nouveau à chaque démarrage. Il est écrit dans
  `run/figma-token`, en 0600, créé en exclusif : un lien symbolique planté à sa place est
  remplacé, jamais suivi. Il est effacé à l'arrêt. Brightky le colle dans le plugin, qui le garde
  dans le stockage local de Figma.
- **Pas de code venu de l'extérieur** :
  - un catalogue fixe de 9 opérations ; aucun outil ne porte de JavaScript, qui reste N4 ;
  - le plugin revalide chaque opération contre le même catalogue et refuse le reste (clés en
    trop, types, bornes, version) ;
  - des tests vérifient que le plugin et le daemon acceptent et refusent la même chose.
- **Le réel décide** :
  - un calque doit avoir été lu avant d'être modifié ;
  - son empreinte (type, nom, texte) repart avec l'écriture : s'il a changé depuis, le plugin
    refuse ;
  - un niveau N1 n'est valable que dans la page « Jarvis drafts », marquée par une donnée privée
    du plugin : ailleurs, le plugin refuse (`figma.not_draft`) ;
  - hors de cette page, toute modification est N2, avec l'avant → après exact.
- **Taint** : tout ce qui est lu dans Figma (noms, textes, variables, export) est une donnée
  externe. La session est teintée : N3 est refusé ensuite et N2 exige un humain. Une consigne de
  worker écrite après une lecture est encadrée comme externe (ADR-027).
- **Messages du plugin** : le daemon ne relaie au modèle que des messages fixes par code
  d'erreur, car le texte libre du plugin peut citer le fichier. Les réponses du plugin sont
  validées par schéma et bornées.
- **Exports** : PNG de 2048 px et 3,5 Mo au plus, envoyés au modèle, jamais dans l'audit (empreinte
  et taille seulement).
- **Un seul fichier à la fois** : le dernier plugin connecté remplace l'autre. Ce qui était en
  attente pour l'ancien échoue, et seule la session qui a reçu une opération peut y répondre.

Nouveau risque (numéro à attribuer à la fusion) :

| # | Risque | Mitigation actuelle | Plan |
|---|---|---|---|
| R? | Un process local qui occuperait le port 47830 avant jarvisd recevrait le jeton collé dans le plugin, et pourrait lui envoyer des opérations du catalogue sans passer par le gate | Catalogue fixe revalidé par le plugin : ni suppression ni code. Chaque écriture s'annule (⌘Z). Si le port est pris, le daemon affiche « Figma bridge off » au démarrage | S12 : le plugin authentifie le daemon par défi-réponse HMAC, et le jeton ne circule plus |

## ADR

## ADR-034 — Figma gratuit : plugin de développement et pont local (03/10/2026)

**Contexte.** Brightky demande que Jarvis « sache utiliser Figma ». La recherche « Jarvis pour les
équipes tech » (proposition 14) établit les limites des voies officielles :
- le serveur MCP officiel est plafonné à environ 20 appels d'outil par mois sur le plan gratuit ;
- la lecture d'un fichier par l'API REST est rationnée de la même façon ;
- un usage quotidien demande un siège Dev (12 $/mois, lecture seule) ou Full (16 $/mois) ;
- l'API Variables est réservée à l'Enterprise.

Tout cela sort de la règle du zéro coût. La **Plugin API** est gratuite et sans quota, à deux
conditions : l'app desktop est ouverte, et le plugin est chargé depuis un manifeste local.

**Décision.**
- **Le plugin** (`apps/figma-plugin/`) : `manifest.json`, `code.js` (fil principal) et
  `ui.html` (iframe). C'est du JS simple, sans étape de build, et sans `?.` ni `??` pour rester
  dans ce que le bac à sable accepte depuis longtemps.
  - Il utilise `documentAccess: "dynamic-page"`, donc les API asynchrones.
  - `networkAccess` vaut `allowedDomains: ["none"]` et
    `devAllowedDomains: ["http://localhost:47830"]`.
- **Le pont** (`apps/jarvisd/src/figma/bridge.ts`) : un long-poll HTTP depuis l'iframe (`/hello`,
  `/poll`, `/result`), sur 127.0.0.1 seulement.
  - Node 24 n'a pas de serveur WebSocket et aucune dépendance n'est ajoutée. Une opération à la
    fois, en local : la latence du long-poll est négligeable.
  - Le port est fixe (47830), car le manifeste doit le nommer.
  - `main.ts` ouvre le pont après le socket. S'il échoue, le daemon tourne quand même, sans Figma.
- **L'admission** est une fonction pure, testée : adresse de boucle locale, Host (DNS rebinding),
  Origin (`null` pour l'iframe du plugin, figma.com toléré, toute page web refusée), POST JSON,
  puis jeton Bearer comparé en temps constant. La pré-requête CORS répond aussi à Private Network
  Access de Chromium.
- **Le jeton** : 256 bits, un nouveau à chaque démarrage, dans `run/figma-token` (0600, création
  exclusive, effacé à l'arrêt). Brightky le colle une fois par démarrage, et le plugin le garde.
  - C'est l'option la plus simple qui tienne : le plugin ne peut lire aucun fichier.
  - Un jeton qui meurt avec le daemon borne une fuite.
  - Pas de Trousseau ni de dépendance.
- **Un catalogue fixe** de 9 opérations (`catalogue.ts`, version 1) :
  - lire : `status`, `read`, `variables`, `export_png` ;
  - écrire : `create_frame`, `set_text`, `rename`, `bind_variable`, `create_component`.

  Le plugin le revalide (`code.js`) et refuse tout le reste. Des tests font tourner `code.js` dans
  un bac à sable `node:vm` et vérifient qu'il accepte et refuse exactement ce que les schémas zod
  du daemon acceptent et refusent. Aucun outil ne transporte de JavaScript : c'est N4 par
  construction, sur le principe du catalogue JXA fixe (ADR-024).
- **Les niveaux, décidés par le code** :
  - lectures N0, `ingestsExternal`, parce que les maquettes sont le contenu d'autres personnes ;
  - écriture N1 dans la page « Jarvis drafts », créée par le plugin et marquée par une donnée
    privée du plugin ;
  - N2 ailleurs, avec l'avant → après exact dans le résumé ;
  - un calque inconnu est refusé (`figma.unknown_node`) : il faut le lire d'abord.
- **Le réel décide**, comme pour le navigateur (ADR-024) :
  - l'empreinte lue (FNV-1a du type, du nom et du texte) repart avec l'écriture, et le plugin
    refuse si le calque a changé (`figma.stale`) ;
  - le niveau fixe la portée envoyée : à N1, le plugin refuse un calque qui n'est pas dans la page
    Jarvis drafts (`figma.not_draft`) ;
  - ce que Jarvis sait des calques est oublié quand le plugin change de session : les
    identifiants de nœuds ne valent que dans un fichier.
- **Les design tokens** : la conversion en DTCG 2025.10 se fait dans le daemon (`tokens.ts`,
  testée), et le plugin renvoie les valeurs brutes.
  - Couleurs en sRGB avec `hex`, tailles en `dimension` px selon les portées Figma.
  - Alias en `{groupe.token}`. Les autres modes et `codeSyntax` vont sous
    `$extensions["com.figma"]`.
  - Les variables STRING et BOOLEAN prennent les types non standard `string` et `boolean`.
- **Les exports** : échelle de 0,25 à 4, 2048 px au plus, 3,5 Mo au plus. L'image va au modèle,
  et l'audit ne garde que son empreinte.
- **Annuler** : `figma.commitUndo()` après chaque écriture, donc une étape ⌘Z par action.
- **Le flux** « lis la maquette et génère le composant » : `figma_read_selection` et
  `figma_variables`, puis `worker_start` avec la spec extraite dans la consigne. La session est
  teintée, donc la consigne arrive encadrée comme externe (ADR-027).

**Écarté.**
- **Le serveur MCP officiel et l'API REST** : quotas et sièges payants. Un client MCP maison qui
  se ferait passer pour un client autorisé serait fragile et contraire à l'esprit des conditions.
- **Un outil qui exécute du JavaScript** de la Plugin API (comme `use_figma`) : N4. Une maquette
  piégée pourrait faire écrire n'importe quoi, n'importe où.
- **Talk to Figma MCP et les ponts open source** : ils passent par un WebSocket et des
  dépendances npm, avec un large éventail de commandes, sans niveaux ni jeton.
- **Le WebSocket** : il faudrait un paquet ou une implémentation maison du protocole, et le
  long-poll suffit.
- **Un jeton persistant**, dans le Trousseau ou un fichier stable : moins de copier-coller, mais
  une fuite resterait valable indéfiniment.
- **Un serveur MCP stdio pour les workers** (piste du rapport) : reporté. Le worker reçoit la spec
  dans sa consigne, et il n'a pas besoin d'écrire dans Figma.
- **Toutes les écritures en N2** : la page Jarvis drafts est un bac à sable réversible.

**Tests** :
- le pont sur un vrai HTTP : jeton, boucle locale, Host, Origin, fichier du jeton, délais quand
  le plugin n'est pas connecté ou ne répond pas, STOP, remplacement de session ;
- l'accord entre le catalogue du plugin et celui du daemon, sur une soixantaine de cas ;
- `code.js` contre une fausse Plugin API : la page « Jarvis drafts » seulement, les empreintes,
  les polices, la limite de pages ;
- la conversion DTCG ;
- 12 tests e2e avec le cerveau scripté et un faux plugin qui interroge le pont.

**Non testé en réel** : le plugin dans Figma, qui n'était pas disponible pour ces tests. À
vérifier au premier usage :
- l'import du manifeste (`id` de développement, port dans `devAllowedDomains`) ;
- les appels de l'iframe vers `http://localhost:47830` depuis l'app desktop (Private Network
  Access) ;
- le comportement réel des API `dynamic-page` sur un vrai fichier ;
- le message quand un fichier du plan Starter a déjà ses 3 pages.
