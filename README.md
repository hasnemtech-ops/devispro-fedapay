[README-DEPLOIEMENT.md](https://github.com/user-attachments/files/30105253/README-DEPLOIEMENT.md)
# Devis Pro — Paiement automatique via FedaPay

Ce serveur relie votre compte FedaPay à la livraison automatique de clés d'activation :
le client paie → FedaPay confirme le paiement → la clé est calculée et livrée
automatiquement, sans aucune intervention manuelle de votre part.

## ⚠️ Avant de commencer — lisez ceci

Ce code a été écrit à partir de la documentation officielle FedaPay et d'exemples
d'intégration vérifiés, mais **n'a pas pu être testé en conditions réelles** avant votre
déploiement (aucun accès à l'API FedaPay depuis l'environnement où ce code a été écrit).

**Ne branchez jamais directement de l'argent réel sans tester d'abord en mode SANDBOX**
(mode test gratuit de FedaPay, aucune vraie transaction). Si un message d'erreur apparaît
pendant les tests, envoyez-le-moi et je corrige — exactement comme pour la version Windows.

---

## Étape 1 — Créer votre compte FedaPay

1. Allez sur [fedapay.com](https://fedapay.com) → Créer un compte
2. Un compte est automatiquement créé en mode **test/sandbox** — vous pouvez déjà l'utiliser sans aucun document
3. Pour accepter de vrais paiements plus tard, vous activerez le mode **live** (documents RCCM/IFU requis pour un compte Business complet — voir notre échange précédent)

## Étape 2 — Récupérer vos clés API (mode test d'abord)

1. Dans votre tableau de bord FedaPay, allez dans **Développement → Clés API et librairies**
2. Copiez votre **clé secrète sandbox** (commence par `sk_sandbox_...`)
3. Gardez cette page ouverte, vous en aurez besoin à l'étape 5

## Étape 3 — Créer un dépôt GitHub (sans ligne de commande)

1. Créez un compte gratuit sur [github.com](https://github.com) si vous n'en avez pas
2. Cliquez sur **New repository** (bouton vert "New")
3. Nommez-le `devispro-fedapay`, laissez-le **Public** ou **Private** (peu importe), cliquez sur **Create repository**
4. Sur la page du dépôt vide, cliquez sur **uploading an existing file**
5. Glissez-déposez les 2 fichiers fournis ici : `package.json` et `server.js`
6. Cliquez sur **Commit changes**

## Étape 4 — Déployer sur Render.com (gratuit)

1. Créez un compte gratuit sur [render.com](https://render.com) (vous pouvez vous inscrire directement avec votre compte GitHub, plus simple)
2. Cliquez sur **New +** → **Web Service**
3. Connectez votre compte GitHub si demandé, puis sélectionnez le dépôt `devispro-fedapay`
4. Render détecte automatiquement Node.js. Vérifiez :
   - **Build Command** : `npm install`
   - **Start Command** : `npm start`
   - **Instance Type** : Free
5. Cliquez sur **Create Web Service** (premier déploiement, peut prendre 2-3 minutes)
6. Une fois déployé, notez l'URL fournie par Render, du type :
   ```
   https://devispro-fedapay.onrender.com
   ```

⚠️ Sur le plan gratuit de Render, le service "s'endort" après 15 minutes sans visite, et
met 30-60 secondes à se "réveiller" au premier accès suivant. C'est normal et sans
conséquence pour ce type d'usage (le client attend juste un peu plus longtemps sur la
première page).

## Étape 5 — Configurer les variables d'environnement sur Render

Dans le tableau de bord Render, ouvrez votre service → onglet **Environment** → ajoutez
ces variables une par une (**Add Environment Variable**) :

| Variable | Valeur | Exemple |
|---|---|---|
| `FEDAPAY_SECRET_KEY` | Votre clé secrète FedaPay (sandbox pour tester) | `sk_sandbox_xxxxx` |
| `FEDAPAY_ENV` | `sandbox` pour tester, `live` une fois prêt | `sandbox` |
| `FEDAPAY_WEBHOOK_SECRET` | Voir étape 6 ci-dessous | `wh_sandbox_xxxxx` |
| `LICENSE_SECRET` | Votre secret de licence (identique à l'app) | `HSM14-68BRA-GNI34-00001` |
| `PUBLIC_BASE_URL` | L'URL Render de l'étape 4 (sans slash final) | `https://devispro-fedapay.onrender.com` |
| `PRICE_1M_XOF` | Prix de la licence 1 mois en FCFA | `2000` |
| `PRICE_1A_XOF` | Prix de la licence 1 an en FCFA | `15000` |

Cliquez sur **Save Changes** → Render redéploie automatiquement.

## Étape 6 — Créer le Webhook côté FedaPay

1. Dans votre tableau de bord FedaPay → **Développement → Webhooks** → **Créer un Webhook**
2. URL de destination :
   ```
   https://devispro-fedapay.onrender.com/webhook
   ```
   (remplacez par votre propre URL Render)
3. Choisissez **Recevoir tous les événements** (ou au minimum `transaction.approved`, `transaction.declined`, `transaction.canceled`)
4. Cliquez sur **Créer**
5. Une fois créé, cliquez sur le webhook puis **"Click to reveal"** pour voir sa **clé secrète** (commence par `wh_sandbox_...` en mode test)
6. Copiez cette clé et mettez-la à jour dans la variable `FEDAPAY_WEBHOOK_SECRET` sur Render (étape 5)

## Étape 7 — Tester en mode sandbox

1. Ouvrez `https://devispro-fedapay.onrender.com` (votre URL Render)
2. Remplissez le formulaire avec un code appareil de test (ex : `TEST-1234`), renouvellement 1, plan de votre choix, et des informations de contact fictives
3. Vous serez redirigé vers la page de paiement FedaPay **en mode test** — utilisez les numéros de test Mobile Money documentés par FedaPay (section Test de leur documentation) pour simuler un paiement réussi
4. Vous devez être automatiquement redirigé vers la page de résultat, avec la clé qui apparaît après quelques secondes
5. Vérifiez que cette clé correspond à ce que produirait `generateur-cles.html` avec les mêmes valeurs

**Si ça ne fonctionne pas**, regardez les logs de votre service sur Render (onglet **Logs**)
et envoyez-moi le message d'erreur exact.

## Étape 8 — Passer en argent réel

Une fois les tests concluants :
1. Activez votre compte FedaPay en mode **live** (documents entreprise requis)
2. Remplacez `FEDAPAY_SECRET_KEY` par votre clé **live** (`sk_live_...`)
3. Remplacez `FEDAPAY_ENV` par `live`
4. Créez un **nouveau Webhook** en mode live (les secrets sont différents entre test et live) et mettez à jour `FEDAPAY_WEBHOOK_SECRET`
5. Retestez une fois avec un tout petit montant réel avant de diffuser le lien à vos clients

## Ce qu'il reste à votre charge

- **Support client** : si un client rencontre un souci de paiement, il devra vous contacter (le bouton WhatsApp de l'application reste utile pour ça)
- **Suivi des paiements** : consultable à tout moment dans votre tableau de bord FedaPay
- **Limite technique honnête** : le stockage des transactions "en attente" est actuellement en mémoire simple (pas de base de données). Pour un usage modeste c'est très bien ; si votre volume grandit beaucoup, on pourra ajouter une vraie base de données gratuite (Render propose un PostgreSQL gratuit).

## Suspendre une licence à distance

L'application vérifie discrètement (et sans bloquer si pas d'internet) auprès de ce serveur si sa licence a été suspendue.

### Configuration (une seule fois)

Sur Render, ajoutez une nouvelle variable d'environnement :

| Variable | Valeur |
|---|---|
| `ADMIN_PASSWORD` | Un mot de passe de votre choix, gardé secret |

### Utilisation

1. Allez sur `https://VOTRE-URL-RENDER.onrender.com/admin`
2. Votre navigateur demande un identifiant : utilisateur = n'importe quoi (ex: `admin`), mot de passe = celui configuré ci-dessus
3. Collez le **code appareil** du client à suspendre → **Suspendre cette licence**
4. Pour lever la suspension plus tard, cliquez sur **Réactiver** en face du code concerné

### ⚠️ Limites honnêtes à connaître

- **Ça ne fonctionne que si l'appareil du client a internet** au moment où il relance l'app. Un appareil qui reste hors-ligne en permanence ne recevra jamais l'ordre de suspension — c'est la contrepartie inévitable d'une application pensée pour fonctionner sans connexion.
- **La liste des suspensions est stockée dans un simple fichier** sur le serveur Render. Sur le plan gratuit, ce fichier peut être réinitialisé si le service redémarre après une longue période d'inactivité (rare, mais possible). Vérifiez votre page `/admin` de temps en temps ; si une suspension a disparu, il suffit de la refaire. Si cela vous gêne à l'usage, on pourra brancher une vraie base de données persistante plus tard.

## Page d'administration complète (générer, suspendre, suivre)

La page `/admin` contient maintenant 3 sections :

1. **🔑 Générer une licence** — pour un code appareil donné, choisissez le numéro de renouvellement et le plan, cliquez "Générer la clé" : elle s'affiche immédiatement et est enregistrée dans le registre.
2. **🚫 Suspendre une licence** — inchangé.
3. **📄 Liste des licences générées** — historique de toutes les licences (payées via FedaPay OU générées manuellement), avec code appareil, plan, n° de renouvellement, date de génération, date d'expiration **estimée**, origine, et statut (**Active** / **Suspendue** / **Expirée**).

⚠️ La date d'expiration affichée est une **estimation** (génération + durée du plan), en supposant que le client active sa clé peu après l'avoir reçue — l'app elle-même ne remonte jamais la date réelle d'activation à ce serveur, par conception (elle reste hors-ligne). Même limite de persistance que pour les suspensions : registre stocké dans un fichier, potentiellement réinitialisé après une longue inactivité sur le plan gratuit.

