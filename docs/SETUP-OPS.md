# Serveurs et déploiements

Jarvis peut lire l'état de tes serveurs, déployer tes apps et brancher la CI d'un dépôt sur un
serveur. Il n'atteint que les serveurs que **tu** déclares dans ta politique. Elle est scellée : il ne
peut pas s'en ajouter un.

## 1. Préparer le serveur (une fois)

```bash
ssh deploy@bb-srv           # accepte l'empreinte : le serveur entre dans ~/.ssh/known_hosts
```

Jarvis se connecte avec tes clés ou ton agent SSH, sans mot de passe, et **refuse un serveur absent
de known_hosts** (protection contre l'usurpation). Il ne lit jamais `~/.ssh` lui-même : c'est `ssh`
qui le fait.

Sur le serveur, un script de déploiement que tu maîtrises, par exemple `/srv/portfolio/deploy.sh` :

```bash
#!/usr/bin/env bash
set -euo pipefail
cd /srv/portfolio
git pull --ff-only
docker compose up -d --build
```

## 2. Déclarer le serveur dans la politique

Dans `config/policy.yaml` :

```yaml
ops:
  servers:
    - id: bb-srv
      host: bb-srv              # nom d'hôte ou alias de ~/.ssh/config
      user: deploy
      env: prod                 # prod : ton PIN pour tout changement ; staging/dev : une confirmation
      apps:
        - id: portfolio
          repo: BrightkyEfoo/portfolio_v3
          deploy: [/srv/portfolio/deploy.sh]
          logs: [docker, compose, -f, /srv/portfolio/compose.yml, logs, --tail, "200"]
        - id: dala              # une app déployée par Coolify
          coolify: { url: "https://coolify.exemple.cm", uuid: "abcd1234", token_vault: coolify }
```

Puis re-scelle la politique :

```bash
sudo ops/scripts/seal-policy.sh config/policy.yaml
```

## 3. Le coffre

Ce sont les valeurs que Jarvis utilise sans jamais les voir : jeton Coolify, mot de passe de base
de données à mettre en secret de CI…

```bash
jarvis vault set coolify      # saisie masquée, rangée dans le Trousseau
jarvis vault list
jarvis vault rm coolify
```

## 4. À dire à Jarvis

| Tu dis | Ce qu'il fait | Validation |
|---|---|---|
| « Jarvis, l'état de bb-srv ? » | `uptime`, `df`, `docker ps`… | aucune |
| « Les logs du portfolio » | la commande de logs déclarée | aucune |
| « Déploie le portfolio » | le script déclaré, ou le webhook Coolify | **PIN** en prod |
| « Redémarre le conteneur web sur bb-srv » | `docker compose restart web` | **PIN** en prod, « oui » en staging |
| « Mets DB_PASSWORD du coffre en secret du dépôt portfolio » | `gh secret set` (stdin) / variable GitLab | **PIN** |
| « Génère un JWT_SECRET pour le dépôt » | valeur aléatoire, copie dans le coffre | **PIN** |
| « Branche la CI du portfolio sur bb-srv » | clé ed25519 bridée + secrets `DEPLOY_*` + workflow à ajouter | **PIN** |

**Jamais**, même avec le PIN : `rm`, `sudo` en commande libre, `curl`/`wget`, shells et
interpréteurs, `docker … prune`, `docker volume rm`, `compose down -v`, `kubectl delete`,
`terraform destroy`, `git push --force`. Ce qui demande des privilèges passe par **ton** script de
déploiement.

**Session propre** : après avoir lu des logs ou des mails (contenu externe), un déploiement en prod
est refusé. Dis « nouvelle session », puis redemande. Une commande cachée dans un log ne peut donc
pas déclencher un déploiement.

## 5. CI → serveur (GitHub Actions)

`deploy_key_setup` génère une paire de clés et installe la clé publique sur le serveur, avec
`restrict,command="<ton script>"` : **la CI ne peut lancer que le déploiement**, rien d'autre (pas de
shell, pas de redirection de ports). Il range ensuite dans les secrets du dépôt `DEPLOY_SSH_KEY`,
`DEPLOY_HOST`, `DEPLOY_USER`, `DEPLOY_PORT` et `DEPLOY_KNOWN_HOSTS`, puis te donne le fichier
`.github/workflows/deploy.yml` à relire et à pousser toi-même. Les workers ne touchent jamais à la
CI.

Prérequis GitHub : `brew install gh`, puis `gh auth login`. Les secrets passent par `gh` : les tokens
fine-grained de Jarvis n'ont volontairement pas le droit d'écrire des secrets.

---

fait avec ❤️ par Brightky Efo'o — https://brightkyefoo.cm
