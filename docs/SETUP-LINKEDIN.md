# LinkedIn

Jarvis rédige tes posts, prépare des visuels (cartes de texte ou de code, captures de fenêtre), publie
**quand tu le dis** et apprend de tes statistiques. Tout est gratuit et dans les règles de LinkedIn.

## 1. Ton app LinkedIn (une fois, gratuit)

1. Va sur https://www.linkedin.com/developers/apps/new. L'app doit être rattachée à une **Page
   LinkedIn** : la tienne, ou une Page créée pour l'occasion. Un super admin de la Page la vérifie.
2. Onglet **Products** : ajoute « **Share on LinkedIn** » et « **Sign In with LinkedIn using OpenID
   Connect** ». Ils sont gratuits et sans revue.
3. Onglet **Auth** › *Authorized redirect URLs* : `http://127.0.0.1:8765/callback`
4. Puis, dans Terminal :

```bash
jarvis linkedin connect      # Client ID, Client Secret (masqué), puis consentement dans le navigateur
```

Le jeton dure **60 jours** et LinkedIn ne permet pas de le renouveler automatiquement. Jarvis te
prévient 10 jours avant la fin : relance alors `jarvis linkedin connect`.

## 2. À dire à Jarvis

| Tu dis | Ce qu'il fait |
|---|---|
| « Jarvis, prépare un post sur la preuve avant les PR » | Il lit d'abord ce qui marche chez toi (`linkedin_insights`), puis propose le texte |
| « Fais-en une carte avec le code » | Il crée une image 1080×1350 signée (`linkedin_card`) et te la montre |
| « Ajoute une capture de VS Code » | Il capture la fenêtre (`linkedin_screenshot`) ; vérifie qu'elle ne montre rien de privé |
| « Publie » | Validation avec le **texte exact**, puis publication par l'API officielle |
| « J'ai téléchargé mes stats » | Import de l'export XLSX (`linkedin_stats_import`), puis leçons tirées des tops et des flops |
| « Réponds aux commentaires d'hier » | Il lit tes mails de notification et propose des réponses ; c'est toi qui les postes |

## 3. Tes statistiques

LinkedIn ne donne pas les statistiques des profils personnels à une app de particulier : l'API
correspondante est réservée aux entreprises immatriculées. La voie gratuite et conforme :

1. sur LinkedIn : **Analytics › Contenu › Exporter** (7 à 365 jours, fichier .xlsx) ;
2. « Jarvis, importe mes stats LinkedIn » : il prend le dernier export de Téléchargements.

Jarvis compare chaque post à la **médiane de tes 10 posts précédents**, ce qui compte plus que
les chiffres bruts quand ton audience grandit. Il marque les tops (×1,5 et plus) et les flops
(×0,6 et moins), puis compare les formats : PDF, images, liens, accroche en question, longueur,
horaire… Ce sont des **hypothèses** à confirmer, une variable à la fois.

## 4. Ce que Jarvis ne fait pas, et pourquoi

- **Il ne pilote jamais linkedin.com** (clics, lecture de pages, extensions) : le contrat
  d'utilisation de LinkedIn l'interdit (§8.2) et ton compte risquerait une restriction. Le pilotage du
  navigateur refuse ce site.
- **Pas de publication programmée en automatique** : les conditions de l'API interdisent
  d'automatiser la publication. Jarvis publie au moment où tu valides. Pour programmer, il te met un
  rappel, ou tu utilises la programmation native de LinkedIn.
- **Pages d'entreprise et groupes** : il n'y a pas d'API ouverte aux particuliers. Jarvis prépare les
  brouillons et tu publies.

---

fait avec ❤️ par Brightky Efo'o — https://brightkyefoo.cm
