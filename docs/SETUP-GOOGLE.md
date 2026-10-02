# Connecter Gmail et Google Agenda

À faire une seule fois. C'est gratuit (projet Google Cloud personnel), compte environ 10 minutes, et
consomme peu de données (quelques pages web).

## 1. Créer le projet
1. Va sur <https://console.cloud.google.com>, connecté avec `brightkyefoo@gmail.com`.
2. Crée un nouveau projet nommé **Jarvis**.

## 2. Activer les deux API
Menu **APIs & Services → Library** : active **Gmail API**, puis **Google Calendar API**.

## 3. Écran de consentement
Menu **Google Auth Platform**, ou « OAuth consent screen » :
1. Type d'utilisateur : **External**. Nom de l'app : `Jarvis`, avec ton adresse en e-mail de support.
2. **Audience → Test users** : ajoute `brightkyefoo@gmail.com`.
3. **Audience → Publish app** (« In production »).
   - D'après la documentation Google, une app restée en mode *Testing* voit ses tokens expirer au
     bout de **7 jours**, et Jarvis devrait alors être reconnecté chaque semaine.
   - Une app publiée sans vérification fonctionne pour toi seul : Google affichera un avertissement
     « app non vérifiée ». Clique **Paramètres avancés → Accéder à Jarvis** : c'est ta propre app.

## 4. Identifiants
**Clients → Create client** :
1. Type **Desktop app**, nom `Jarvis CLI`.
2. Télécharge le fichier JSON (`client_secret_….json`).

## 5. Connecter Jarvis (un ou plusieurs comptes Gmail)
```bash
jarvis google connect ~/Downloads/client_secret_XXXX.json   # 1er compte (le fichier une seule fois)
jarvis google connect                                        # chaque compte Gmail en plus
jarvis service install --app                                 # redémarre Jarvis
jarvis mail test                                             # vérifie l'accès
```

À chaque connexion, Google te laisse **choisir le compte**. Jarvis lit l'adresse autorisée,
l'ajoute à ta politique (`config/policy.yaml`, re-scellée avec ton mot de passe Mac) et lui donne
un identifiant tiré de l'adresse (`brightefoo@gmail.com` → `brightefoo`). Les agendas de tous
les comptes sont fusionnés dans le briefing, sauf si tu en épingles un avec
`calendar.google_account`.

Tant que l'app Google est en mode « Test », chaque adresse doit figurer dans **Audience →
Utilisateurs test**.

Le navigateur s'ouvre. Accepte trois autorisations :
- **lecture** des mails ;
- **brouillons**, en sachant que Google n'a pas de permission « brouillon sans envoi » : c'est le
  moteur de permissions de Jarvis qui bloque tout envoi sans ta confirmation (N2) ;
- **lecture** de l'agenda.

Le token reste dans le Trousseau macOS. Tu peux ensuite supprimer le fichier `client_secret`.

**Pour révoquer** : <https://myaccount.google.com/permissions> → Jarvis → Supprimer l'accès.

## Boîtes pro (IMAP)
1. Déclare le compte dans `mail.accounts` de la politique : hôte, ports, TLS.
2. Lance `jarvis mail add <id>` pour le mot de passe (de préférence un mot de passe d'application).
3. Vérifie avec `jarvis mail test`.

TLS est obligatoire. Si le serveur utilise un certificat auto-signé, colle ce certificat dans
`ca_pem` : Jarvis ne désactive jamais la vérification.

Lors du test du 1er octobre 2026 :
- `mail.transitsoftservices.com` n'existait plus dans le DNS ;
- `scriptify.cm` ne répondait pas sur les ports IMAP et SMTP depuis ton réseau.

Il faut donc les bons paramètres auprès de ton hébergeur.
