# Connecter Figma (gratuit, sans quota)

> Jarvis parle à Figma par un **plugin de développement** chargé dans l'app desktop. Pas de siège
> payant, pas de token Figma, pas de limite d'appels : tout reste sur le Mac, en 127.0.0.1.

Pourquoi pas le serveur MCP officiel de Figma : sur le plan gratuit, il est plafonné à environ
**20 appels par mois**, comme la lecture d'un fichier par l'API REST. Un usage quotidien demande un
siège Dev (12 $/mois, lecture seule) ou Full (16 $/mois). La Plugin API, elle, n'a pas de quota.

## Une fois : charger le plugin

1. Ouvre l'**app desktop** Figma : le navigateur ne charge pas les plugins locaux. Ouvre ensuite
   un fichier de design.
2. Menu **Plugins › Development › Import plugin from manifest…**, puis choisis
   `apps/figma-plugin/manifest.json` dans le dépôt Jarvis.
3. Le plugin **Jarvis** apparaît dans Plugins › Development. Figma relit les fichiers du plugin à
   chaque lancement : une mise à jour du dépôt suffit, rien à réimporter.

## À chaque démarrage de Jarvis : le jeton

Au démarrage, le daemon écrit un **jeton aléatoire** dans
`~/Library/Application Support/Jarvis/run/figma-token`. Ce fichier est en 0600 et le jeton change
à chaque démarrage. Il est effacé quand le daemon s'arrête.

1. Lance le plugin : Plugins › Development › Jarvis.
2. La première fois, il demande le jeton. Dans un terminal :

   ```bash
   pbcopy < ~/Library/Application\ Support/Jarvis/run/figma-token
   ```

   Colle-le dans le champ, puis clique sur **Connecter**. Le plugin le garde sur ce Mac (stockage
   local de Figma).
3. Après un redémarrage de Jarvis, le plugin affiche « Jeton refusé » : recopie le nouveau jeton.

Pourquoi un copier-coller : le plugin tourne dans le bac à sable de Figma et ne peut lire aucun
fichier. Un jeton qui meurt avec le daemon limite les dégâts s'il fuyait, et cette solution
n'utilise ni le Trousseau ni aucune dépendance.

## Utilisation

- Garde la petite fenêtre du plugin ouverte dans le fichier où Jarvis travaille. **Un fichier à
  la fois** : le dernier plugin lancé prend la main, et l'autre affiche « Reprendre la main ».
- Exemples :
  - « Jarvis, lis la maquette sélectionnée et génère le composant » : Jarvis lit la sélection et
    les variables, puis confie le code à un worker, avec la spec extraite ;
  - « exporte les variables en design tokens » ;
  - « montre-moi le frame sélectionné » ;
  - « dessine un formulaire de connexion dans mes brouillons ».

## Ce que Jarvis peut faire : un catalogue fixe

| Outil | Ce qu'il fait | Niveau |
|---|---|---|
| `figma_status` | Fichier, page, sélection | N0 |
| `figma_read_selection` | Arbre des calques : tailles, auto layout, textes, couleurs en hex, variables liées, propriétés de composants | N0 |
| `figma_variables` | Variables locales en design tokens W3C (DTCG) | N0 |
| `figma_export` | PNG d'un calque, montré au modèle comme une capture d'écran | N0 |
| `figma_create_frame` | Frame en auto layout (frames, textes, rectangles) dans la page **Jarvis drafts** | N1 |
| `figma_set_text`, `figma_rename`, `figma_bind_variable`, `figma_create_component` | Modifier un calque | N1 dans **Jarvis drafts**, N2 ailleurs |

- **N2** : tu valides, et l'écran de validation montre l'**avant → après** exact.
- Jarvis doit avoir **lu un calque** avant de le modifier. Si le calque a changé depuis, le
  plugin refuse.
- **Jamais de JavaScript arbitraire** (N4) : ni le daemon ni le plugin n'exécutent de code reçu.
  Le plugin revalide chaque opération contre le même catalogue que le daemon.
- **Annuler** : chaque action de Jarvis est une étape d'annulation dans Figma (⌘Z). La page Jarvis
  drafts se supprime comme n'importe quelle page.

## Ce qui marche sur le plan gratuit (Starter)

- **Tout le catalogue** : les plugins de développement fonctionnent sur tous les plans dans l'app
  desktop, et la Plugin API n'a pas de quota.
- **Les variables locales du fichier** : lecture et liaison. Les variables d'une bibliothèque
  apparaissent par leur nom quand un calque les utilise, mais ne sont pas exportées.
- **Limite des 3 pages** : un fichier Starter est limité à 3 pages. Si le fichier en a déjà 3,
  Jarvis ne peut pas y créer « Jarvis drafts » et le dit. Libère une page, ou travaille dans un
  fichier de tes brouillons.
- **Hors d'atteinte** : les commentaires, l'historique des versions et Code Connect (API REST ou
  plans payants).

## Sécurité

- Le pont écoute **seulement 127.0.0.1:47830**. Il refuse :
  - une requête sans le jeton ;
  - une autre adresse que la boucle locale ;
  - un en-tête Host autre que `127.0.0.1` ou `localhost` (DNS rebinding) ;
  - l'Origin d'une page web.
- Lire un design **teinte la session** : ensuite, N3 est refusé et N2 toujours confirmé.
- Les exports vont au modèle, jamais dans l'audit, qui n'en garde que l'empreinte.

## Dépannage

- **« Jarvis injoignable »** : le daemon ne tourne pas, ou le port 47830 est déjà pris. Au
  démarrage, le daemon écrit alors « Figma bridge off » dans son journal.
- **« Jeton refusé »** : recopie le jeton (commande ci-dessus).
- **« Une autre fenêtre Figma utilise Jarvis »** : clique sur « Reprendre la main ».
- **« Ce plugin n'est plus à jour »** : ferme le plugin et relance-le.
