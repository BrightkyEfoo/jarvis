# Connecter GitHub, GitLab et Trello

> Le plus simple : `jarvis setup`. Il ouvre chaque page pré-remplie et vérifie chaque token.
> Ce qui suit détaille ce qu'il fait.

Les tokens vont dans le Trousseau macOS. Ils ne passent jamais par le modèle ni par le socket du
daemon. Après chaque connexion, redémarre le daemon (`jarvis service install` le relance, ou
`jarvis daemon`).

## GitHub (token « fine-grained », sans droits d'administration)

1. Va sur github.com › Settings › Developer settings › **Fine-grained tokens** › Generate new
   token.
2. Choisis le **propriétaire** : ton compte. Un token fine-grained ne couvre qu'un
   propriétaire : crée **un token par organisation** (`scriptify-cm`, `javascriptcm`).
   `jarvis setup` les demande l'un après l'autre et Jarvis choisit le bon pour chaque dépôt.
3. **Repository access** : *All repositories*.
4. **Permissions** du dépôt :

   | Permission | Niveau |
   |---|---|
   | Contents | Read and write (pour les PR des workers, au S6) |
   | Pull requests | Read and write |
   | Issues | Read and write |
   | Checks, Commit statuses, Metadata | Read-only |
   | Administration, Secrets, Workflows | **No access** |

5. Expiration : 1 an au plus.
6. Lance `jarvis github connect`, puis colle le token (saisie masquée). Jarvis vérifie qui tu es
   avant de l'enregistrer.

## GitLab

1. Va sur gitlab.com › Preferences › **Access tokens**, ou sur ton instance.
2. Portée : **api**, nécessaire pour commenter et, plus tard, ouvrir des MR. Expiration : 1 an
   au plus.
3. Lance `jarvis gitlab connect`, ou `jarvis gitlab connect https://gitlab.exemple.com` pour une
   instance auto-hébergée.
4. Pour une instance auto-hébergée, ajoute `forges.gitlab_url: https://gitlab.exemple.com` dans la
   politique, puis scelle-la à nouveau.

## Trello

1. Va sur trello.com/power-ups/admin, crée une Power-Up (n'importe quel nom), puis génère sa
   **clé API**.
2. Sur la même page, clique sur le lien **Token** et autorise la lecture et l'écriture.
3. Lance `jarvis trello connect`, puis colle la clé et le token.

## Cartes Trello → workers (S7)

1. Étiquette une carte **`jarvis`** (`forges.trello_label` dans la politique).
2. Indique le dépôt, au choix :
   - une ligne `repo: owner/repo` dans la description de la carte (`repo: gitlab:groupe/projet`
     pour GitLab) ;
   - une correspondance tableau → dépôt dans `forges.trello_boards`.
3. Dis « prends mes cartes Trello ». Tu valides une fois pour tout le lot. Ensuite, chaque carte
   suit ce cycle :
   - elle passe dans « En cours » et un worker s'en charge ;
   - quand la PR est ouverte, elle reçoit le lien de la PR et passe dans « À relire ».

   Les noms de colonnes reconnus se règlent avec `forges.trello_doing` et
   `forges.trello_review`.
4. Pour écouter le résultat : « relis-moi la PR du mode sombre ».

## Ce que Jarvis fait avec

| Action | Niveau |
|---|---|
| Lire les PR, MR, issues, diffs, cartes et tableaux | N0 |
| Commenter une PR, une MR, une issue ou une carte | N2 : tu valides le texte exact |
| Déplacer une carte | N2 |
| Merger | jamais automatique (ADR-023) ; arrive avec les workers |

Pour qu'un commentaire parte sans validation sur un dépôt précis, ajoute une règle
`auto_approve` dans la politique, par exemple :

```yaml
auto_approve:
  - { tool: forge_comment, when: { repo: [BrightkyEfoo/jarvis] } }
```

Même dans ce cas, la règle ne s'applique pas après lecture d'un contenu externe dans la même
conversation : Jarvis te demande alors toujours.
