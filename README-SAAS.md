# Devis Pro SaaS : comptes et synchronisation

## Ce qui a été ajouté

- **Comptes clients** (e-mail et mot de passe), créés depuis l'application avec le bouton ☁️ en haut à droite.
- **Synchronisation** des devis, factures, articles et entreprises entre tous les appareils du client (Android, iPhone, Windows, Mac, navigateur). L'application fonctionne toujours hors-ligne et synchronise dès que la connexion revient.
- **Version web** : `https://devispro.hasnemtech.com/app`
- **Administration des comptes** : `https://devispro.hasnemtech.com/admin/comptes` (bouton « 👥 Comptes clients » sur /admin). Elle permet de changer le mot de passe d'un client qui l'a oublié et de supprimer un compte.
- **La licence reste par appareil** (clé d'activation). Sans licence active, l'application est **entièrement verrouillée** : rien n'est affiché, créé, modifié, imprimé ni envoyé. Les données restent conservées et réapparaissent après l'activation.
- **Essai gratuit unique par compte** : la date d'essai la plus ancienne du compte s'applique à tous ses appareils. Réinstaller l'app ou vider le navigateur ne relance pas d'essai.
- **Appareils par compte** : la page « Comptes clients » liste chaque appareil (code, plateforme, licence payée ou non). Un compte en rouge a plus d'appareils que de licences.

## Installation sur le VPS (dossier `/var/www/devispro`)

### 1. Installer PostgreSQL
```bash
apt update
apt install -y postgresql
systemctl enable --now postgresql
```

### 2. Créer la base et l'utilisateur
Remplacez `MOT_DE_PASSE_FORT` par un vrai mot de passe, sans espace ni caractère `@`, `:` ou `/`.
```bash
sudo -u postgres psql -c "CREATE USER devispro WITH PASSWORD 'MOT_DE_PASSE_FORT';"
sudo -u postgres psql -c "CREATE DATABASE devispro OWNER devispro;"
```

### 3. Ajouter deux lignes au fichier `.env`
```bash
cd /var/www/devispro
echo "DATABASE_URL=postgres://devispro:MOT_DE_PASSE_FORT@localhost:5432/devispro" >> .env
echo "SAAS_SECRET=$(openssl rand -hex 32)" >> .env
```
⚠️ Ne changez jamais `SAAS_SECRET` par la suite : tous les clients seraient déconnectés.

### 4. Copier les nouveaux fichiers
Depuis le PC, envoyez `server.js`, `saas.js`, `package.json` et le dossier `public/` dans `/var/www/devispro/`.

### 5. Installer et redémarrer
```bash
cd /var/www/devispro
npm install
pm2 restart devispro-fedapay
pm2 logs devispro-fedapay --lines 20
```
Les logs doivent afficher : `SaaS : base PostgreSQL prête.`

### 6. Autoriser les envois volumineux dans Nginx
Les logos et tampons peuvent peser plusieurs centaines de Ko. Sans ce réglage, Nginx refuse les envois de plus de 1 Mo.
Dans le fichier du site Devis Pro (`/etc/nginx/sites-available/...`), ajoutez dans le bloc `server { ... }` :
```
client_max_body_size 25M;
```
Puis :
```bash
nginx -t && systemctl reload nginx
```

## Sauvegarde de la base (recommandé)
```bash
sudo -u postgres pg_dump devispro > /root/devispro-$(date +%F).sql
```
Une sauvegarde automatique chaque nuit à 2 h :
```bash
(crontab -l 2>/dev/null; echo '0 2 * * * sudo -u postgres pg_dump devispro > /root/backup-devispro-$(date +\%u).sql') | crontab -
```
Cette commande conserve 7 sauvegardes, une par jour de la semaine.

## Plusieurs appareils sur le même compte
- **Numérotation** : avant de créer un document, l'application récupère la numérotation à jour. Si deux appareils hors-ligne attribuent le même numéro, le premier synchronisé le garde. L'autre document reçoit automatiquement le prochain numéro libre, et l'application prévient l'utilisateur. Dans l'aperçu, un document pas encore synchronisé est signalé (« numéro confirmé à la prochaine connexion »).
- **Modifications simultanées** : rien n'est jamais écrasé. Si le même document, article ou entreprise a été modifié sur deux appareils, une bande orange apparaît et l'utilisateur choisit : garder la version de cet appareil, garder l'autre, ou garder les deux (copie avec un nouveau numéro).
- Lorsque vous changez le mot de passe d'un client dans l'administration, tous ses appareils sont déconnectés. Ses données restent sur ses appareils et sur le serveur.
