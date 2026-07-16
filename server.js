/**
 * Devis Pro — Serveur de paiement + livraison automatique de licence
 * --------------------------------------------------------------
 * Flux complet :
 *   1. Le client remplit le formulaire (code appareil, n° renouvellement, plan, coordonnées)
 *   2. Ce serveur crée une transaction FedaPay et redirige le client vers la page de paiement FedaPay
 *   3. Le client paie (Mobile Money / carte)
 *   4. FedaPay notifie ce serveur via un Webhook signé ("transaction.approved")
 *   5. Ce serveur calcule la clé d'activation et la garde en mémoire, associée à la transaction
 *   6. Le client, redirigé sur la page de résultat, récupère sa clé automatiquement (sans rien faire)
 *
 * ⚠️ IMPORTANT — À LIRE AVANT DE METTRE EN LIGNE (voir README-DEPLOIEMENT.md) :
 * - Ce code a été écrit à partir de la documentation officielle FedaPay et d'exemples
 *   vérifiés, mais n'a PAS pu être testé en conditions réelles avant votre déploiement
 *   (pas d'accès à l'API FedaPay depuis l'environnement où ce code a été écrit).
 * - Testez impérativement en mode SANDBOX avant de passer en argent réel.
 * - Toutes les clés/secrets se configurent via des variables d'environnement (jamais
 *   écrites en clair ici) — voir README-DEPLOIEMENT.md.
 */

const express = require('express');
const bodyParser = require('body-parser');
const fs = require('fs');
const path = require('path');
const { FedaPay, Transaction, Webhook } = require('fedapay');

const app = express();

/* ============================ CONFIGURATION ============================ */
const FEDAPAY_SECRET_KEY = process.env.FEDAPAY_SECRET_KEY || '';
const FEDAPAY_ENV = process.env.FEDAPAY_ENV || 'sandbox'; // 'sandbox' ou 'live'
const FEDAPAY_WEBHOOK_SECRET = process.env.FEDAPAY_WEBHOOK_SECRET || '';
const LICENSE_SECRET = process.env.LICENSE_SECRET || '';
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || ''; // ex: https://devispro-paiement.onrender.com
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';

const PLAN_PRICES = {
  '1M': parseInt(process.env.PRICE_1M_XOF || '2000', 10),
  '1A': parseInt(process.env.PRICE_1A_XOF || '15000', 10)
};
const PLAN_LABELS = { '1M': '1 mois', '1A': '1 an' };

if (FEDAPAY_SECRET_KEY) {
  FedaPay.setApiKey(FEDAPAY_SECRET_KEY);
  FedaPay.setEnvironment(FEDAPAY_ENV);
}

/* ============================ STOCKAGE (en mémoire) ============================ */
// ⚠️ Simplification volontaire : convient pour un usage modeste. Les données sont
// perdues si le serveur redémarre (le client peut simplement repayer si ça arrive
// avant qu'il ait récupéré sa clé — rare, mais gardez ça en tête). Pour un usage à
// plus grand volume, remplacer par une vraie base de données (ex: Render Postgres gratuit).
const transactions = {}; // transactionId -> { status, deviceCode, renewalIndex, planType, key }

/* ============================ SUSPENSION DE LICENCES ============================ */
// ⚠️ Stocké dans un fichier local (data/revoked.json). Sur le plan gratuit Render, ce
// fichier peut être réinitialisé si le service redémarre après une longue inactivité —
// vérifiez de temps en temps votre page /admin. Pour une persistance garantie à 100%,
// on pourra brancher une vraie base de données plus tard si besoin.
const DATA_DIR = path.join(__dirname, 'data');
const REVOKED_FILE = path.join(DATA_DIR, 'revoked.json');

function loadRevoked() {
  try {
    return JSON.parse(fs.readFileSync(REVOKED_FILE, 'utf8'));
  } catch (e) {
    return {};
  }
}
function saveRevoked(data) {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(REVOKED_FILE, JSON.stringify(data, null, 2));
  } catch (e) {
    console.error('Erreur sauvegarde revoked.json :', e.message);
  }
}
let revokedDevices = loadRevoked(); // { 'AB3D-9F2K': { revokedAt: '...' }, ... }

/* ============================ REGISTRE DES LICENCES GÉNÉRÉES ============================ */
// ⚠️ Même limite que revoked.json : stocké dans un fichier local, peut être réinitialisé
// sur le plan gratuit Render après une longue inactivité. Suffisant pour un usage modeste.
const LICENSES_FILE = path.join(DATA_DIR, 'licenses.json');
const PLAN_DURATIONS = { '1M': 30, '1A': 365 };

function loadLicenses() {
  try {
    return JSON.parse(fs.readFileSync(LICENSES_FILE, 'utf8'));
  } catch (e) {
    return [];
  }
}
function saveLicenses(list) {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(LICENSES_FILE, JSON.stringify(list, null, 2));
  } catch (e) {
    console.error('Erreur sauvegarde licenses.json :', e.message);
  }
}
let licensesLog = loadLicenses(); // [{ deviceCode, renewalIndex, planType, key, generatedAt, source }, ...]

function addDaysISO(dateStr, days) {
  const d = new Date((dateStr || new Date().toISOString().slice(0, 10)) + 'T00:00:00');
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

function licenseStatus(entry) {
  const code = (entry.deviceCode || '').trim().toUpperCase();
  if (revokedDevices[code]) return 'suspendue';
  const expiry = addDaysISO(entry.generatedAt, PLAN_DURATIONS[entry.planType] || 365);
  const today = new Date().toISOString().slice(0, 10);
  if (today > expiry) return 'expiree';
  return 'active';
}
function estimatedExpiry(entry) {
  return addDaysISO(entry.generatedAt, PLAN_DURATIONS[entry.planType] || 365);
}

function requireAdminAuth(req, res, next) {
  if (!ADMIN_PASSWORD) {
    return res.status(500).send('ADMIN_PASSWORD non configuré sur le serveur. Ajoutez cette variable d\'environnement.');
  }
  const auth = req.headers.authorization;
  if (auth) {
    const [, encoded] = auth.split(' ');
    const decoded = Buffer.from(encoded || '', 'base64').toString('utf8');
    const [, pass] = decoded.split(':');
    if (pass === ADMIN_PASSWORD) return next();
  }
  res.set('WWW-Authenticate', 'Basic realm="Administration Devis Pro"');
  return res.status(401).send('Authentification requise.');
}

/* ============================ UTILITAIRES : calcul de la clé ============================ */
// ⚠️ Cet algorithme doit rester STRICTEMENT identique à celui d'electricien-devis.html
// et de generateur-cles.html.
function normalizeKey(s) { return (s || '').toUpperCase().replace(/[^A-Z0-9]/g, ''); }

function computeActivationKey(deviceCode, renewalIndex, planType, secret) {
  const input = normalizeKey(deviceCode) + '#' + String(renewalIndex || 0) + '#' + (planType || '') + '|' + (secret || '');
  let h1 = 0, h2 = 0;
  for (let i = 0; i < input.length; i++) {
    const c = input.charCodeAt(i);
    h1 = (Math.imul(h1, 131) + c) >>> 0;
    h2 = (Math.imul(h2, 137) + c + i) >>> 0;
  }
  h1 = (h1 ^ (h1 >>> 15)) >>> 0;
  h2 = (h2 ^ (h2 >>> 13)) >>> 0;
  const combined = (h1.toString(16) + h2.toString(16) + h1.toString(36) + h2.toString(36)).toUpperCase().replace(/[^A-Z0-9]/g, '');
  let key = combined.slice(0, 12).padEnd(12, '0');
  return key.match(/.{1,4}/g).join('-');
}

/* ============================ PAGE 1 : FORMULAIRE CLIENT ============================ */
app.get('/', (req, res) => {
  res.send(renderFormPage());
});

/* ============================ CRÉATION DE LA TRANSACTION + REDIRECTION PAIEMENT ============================ */
app.use(bodyParser.urlencoded({ extended: true }));

app.post('/pay', async (req, res) => {
  try {
    const { deviceCode, renewalIndex, planType, email, firstname, lastname, phone, country } = req.body;

    if (!deviceCode || !renewalIndex || !planType || !email || !phone) {
      return res.status(400).send(renderErrorPage('Merci de remplir tous les champs obligatoires.'));
    }
    if (!PLAN_PRICES[planType]) {
      return res.status(400).send(renderErrorPage('Type de licence invalide.'));
    }
    if (!FEDAPAY_SECRET_KEY) {
      return res.status(500).send(renderErrorPage("Le serveur n'est pas encore configuré (clé API FedaPay manquante). Contactez l'administrateur."));
    }

    const amount = PLAN_PRICES[planType];

    const transaction = await Transaction.create({
      description: `Licence Devis Pro — ${PLAN_LABELS[planType]}`,
      amount,
      currency: { iso: 'XOF' },
      callback_url: `${PUBLIC_BASE_URL}/result`,
      customer: {
        email,
        firstname: firstname || 'Client',
        lastname: lastname || 'DevisPro',
        phone_number: { number: phone, country: country || 'tg' }
      },
      custom_metadata: {
        deviceCode: deviceCode.trim().toUpperCase(),
        renewalIndex: String(parseInt(renewalIndex, 10) || 1),
        planType
      }
    });

    // On garde une trace "en attente" le temps que le paiement soit confirmé
    transactions[transaction.id] = {
      status: 'pending',
      deviceCode: deviceCode.trim().toUpperCase(),
      renewalIndex: parseInt(renewalIndex, 10) || 1,
      planType,
      key: null
    };

    const tokenResp = await transaction.generateToken();
    const paymentUrl = tokenResp.url || (tokenResp.token && tokenResp.token.url);

    if (!paymentUrl) {
      return res.status(500).send(renderErrorPage("Impossible de générer le lien de paiement. Réponse inattendue de FedaPay."));
    }

    res.redirect(paymentUrl);
  } catch (e) {
    console.error('Erreur /pay :', e);
    res.status(500).send(renderErrorPage('Erreur lors de la création du paiement : ' + e.message));
  }
});

/* ============================ PAGE DE RETOUR APRÈS PAIEMENT ============================ */
app.get('/result', (req, res) => {
  // FedaPay redirige vers callback_url avec des paramètres (souvent ?id=... ou ?transaction_id=...).
  // On récupère l'identifiant quel que soit le nom exact du paramètre.
  const txId = req.query.id || req.query.transaction_id || req.query.transactionId || '';
  res.send(renderResultPage(txId));
});

/* ============================ API interrogée par la page de résultat (JS) ============================ */
app.get('/api/status', (req, res) => {
  const txId = req.query.id;
  if (!txId || !transactions[txId]) {
    return res.json({ status: 'unknown' });
  }
  const entry = transactions[txId];
  res.json({
    status: entry.status, // 'pending' | 'paid' | 'declined'
    key: entry.key,
    planType: entry.planType
  });
});

/* ============================ WEBHOOK FEDAPAY ============================ */
// IMPORTANT : express.raw() ici, PAS bodyParser.json(), pour garder le corps brut
// nécessaire à la vérification de signature.
app.post('/webhook', express.raw({ type: 'application/json' }), (req, res) => {
  let event;
  try {
    event = Webhook.constructEvent(req.body, req.headers['x-fedapay-signature'], FEDAPAY_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Signature webhook invalide :', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // On répond tout de suite (bonne pratique FedaPay), puis on traite.
  res.status(200).json({ received: true });

  try {
    const tx = event.entity || event.object || {};
    const meta = tx.custom_metadata || {};

    if (event.name === 'transaction.approved') {
      const key = computeActivationKey(meta.deviceCode, meta.renewalIndex, meta.planType, LICENSE_SECRET);
      transactions[tx.id] = {
        status: 'paid',
        deviceCode: meta.deviceCode,
        renewalIndex: meta.renewalIndex,
        planType: meta.planType,
        key
      };
      licensesLog.push({
        deviceCode: (meta.deviceCode || '').trim().toUpperCase(),
        renewalIndex: meta.renewalIndex,
        planType: meta.planType,
        key,
        generatedAt: new Date().toISOString().slice(0, 10),
        source: 'paiement'
      });
      saveLicenses(licensesLog);
      console.log(`✅ Paiement confirmé, clé générée pour ${meta.deviceCode} (transaction ${tx.id})`);
    } else if (event.name === 'transaction.declined' || event.name === 'transaction.canceled') {
      if (transactions[tx.id]) transactions[tx.id].status = 'declined';
    }
  } catch (e) {
    console.error('Erreur traitement webhook :', e);
  }
});

/* ============================ PAGES HTML ============================ */
function renderFormPage() {
  return `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Devis Pro — Payer ma licence</title>
${SHARED_STYLE}
</head>
<body>
<div class="card">
  <h1>Payer ma licence Devis Pro</h1>
  <div class="sub">Les informations ci-dessous sont visibles sur l'écran de verrouillage de l'application.</div>

  <form method="POST" action="/pay">
    <label>Code appareil</label>
    <input type="text" name="deviceCode" placeholder="Ex : AB3D-9F2K" required>

    <label>Numéro de renouvellement</label>
    <input type="number" name="renewalIndex" min="1" value="1" required>

    <label>Type de licence</label>
    <div class="plans">
      <label><input type="radio" name="planType" value="1M" required style="width:auto;"> 1 mois</label>
      <label><input type="radio" name="planType" value="1A" checked required style="width:auto;"> 1 an</label>
    </div>

    <label>Prénom</label>
    <input type="text" name="firstname" placeholder="Prénom">

    <label>Nom</label>
    <input type="text" name="lastname" placeholder="Nom">

    <label>E-mail</label>
    <input type="email" name="email" placeholder="vous@exemple.com" required style="text-transform:none;">

    <label>Pays (Mobile Money)</label>
    <select name="country" style="text-transform:none;">
      <option value="tg" selected>Togo</option>
      <option value="bj">Bénin</option>
      <option value="ci">Côte d'Ivoire</option>
      <option value="sn">Sénégal</option>
      <option value="ml">Mali</option>
      <option value="ne">Niger</option>
      <option value="gn">Guinée</option>
    </select>

    <label>Téléphone (Mobile Money)</label>
    <input type="tel" name="phone" placeholder="Ex : 90123456" required style="text-transform:none;">

    <button type="submit">Payer et obtenir ma clé</button>
  </form>
  <div class="note">Après paiement, vous serez automatiquement redirigé ici avec votre clé.</div>
</div>
</body>
</html>`;
}

function renderResultPage(txId) {
  return `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Devis Pro — Votre clé d'activation</title>
${SHARED_STYLE}
</head>
<body>
<div class="card">
  <h1>Votre clé d'activation</h1>
  <div id="waiting">
    <div class="sub">Vérification du paiement en cours... Merci de patienter quelques secondes.</div>
  </div>
  <div class="result" id="result"></div>
  <div class="error" id="error"></div>
</div>
<script>
const txId = ${JSON.stringify(txId)};
let attempts = 0;

async function poll() {
  if (!txId) {
    document.getElementById('waiting').style.display = 'none';
    document.getElementById('error').textContent = "Identifiant de transaction manquant dans le lien.";
    document.getElementById('error').style.display = 'block';
    return;
  }
  attempts++;
  try {
    const res = await fetch('/api/status?id=' + encodeURIComponent(txId));
    const data = await res.json();
    if (data.status === 'paid' && data.key) {
      document.getElementById('waiting').style.display = 'none';
      const box = document.getElementById('result');
      box.textContent = data.key;
      box.style.display = 'block';
      return;
    }
    if (data.status === 'declined') {
      document.getElementById('waiting').style.display = 'none';
      document.getElementById('error').textContent = "Le paiement n'a pas abouti. Aucune clé n'a été générée.";
      document.getElementById('error').style.display = 'block';
      return;
    }
    if (attempts < 30) {
      setTimeout(poll, 3000);
    } else {
      document.getElementById('waiting').style.display = 'none';
      document.getElementById('error').textContent = "Le paiement met du temps à être confirmé. Rafraîchissez cette page dans une minute, ou contactez votre fournisseur.";
      document.getElementById('error').style.display = 'block';
    }
  } catch (e) {
    setTimeout(poll, 3000);
  }
}
poll();
</script>
</body>
</html>`;
}

function renderErrorPage(message) {
  return `<!DOCTYPE html>
<html lang="fr">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Erreur</title>${SHARED_STYLE}</head>
<body>
<div class="card">
  <h1>Une erreur est survenue</h1>
  <div class="error" style="display:block;">${escapeHtml(message)}</div>
  <div class="note"><a href="/">Retour au formulaire</a></div>
</div>
</body>
</html>`;
}

function escapeHtml(s) {
  return (s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const SHARED_STYLE = `<style>
  :root{ --navy:#10233A; --amber:#F5B93D; --bg:#F5F7FA; --muted:#5B6B7C; --border:#E1E5EA; --danger:#C4432B; }
  *{box-sizing:border-box;}
  body{ margin:0; font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif; background:var(--bg); color:#16212E; display:flex; justify-content:center; padding:30px 16px; }
  .card{ background:#fff; border:1px solid var(--border); border-radius:14px; padding:26px; max-width:440px; width:100%; }
  h1{ font-size:19px; color:var(--navy); margin:0 0 4px; }
  .sub{ font-size:12.5px; color:var(--muted); margin-bottom:16px; }
  label{ display:block; font-size:12.5px; font-weight:600; color:var(--muted); margin-bottom:4px; margin-top:14px; }
  input, select{ width:100%; box-sizing:border-box; padding:11px; border:1px solid var(--border); border-radius:8px; font-size:15px; text-align:center; text-transform:uppercase; }
  .plans{ display:flex; gap:8px; margin-top:6px; }
  .plans label{ flex:1; border:1px solid var(--border); border-radius:8px; padding:10px; font-size:13px; font-weight:700; color:var(--navy); cursor:pointer; display:flex; align-items:center; justify-content:center; gap:6px; text-transform:none; margin-top:0; }
  button{ width:100%; margin-top:18px; padding:12px; border:none; border-radius:9px; background:var(--amber); color:var(--navy); font-weight:700; font-size:14.5px; cursor:pointer; }
  .result{ margin-top:16px; background:var(--bg); border:1px dashed var(--border); border-radius:8px; padding:16px; text-align:center; font-size:20px; font-weight:700; letter-spacing:.05em; color:var(--navy); display:none; }
  .error{ color:var(--danger); font-size:12.5px; margin-top:10px; display:none; text-align:center; }
  .note{ font-size:11.5px; color:var(--muted); margin-top:12px; text-align:center; }
</style>`;

/* ============================ SUSPENSION : API PUBLIQUE (appelée par l'app) ============================ */
app.get('/api/check-revoked', (req, res) => {
  // CORS ouvert : endpoint public en lecture seule, ne renvoie qu'un booléen, aucune donnée sensible.
  res.set('Access-Control-Allow-Origin', '*');
  const deviceCode = (req.query.deviceCode || '').toString().trim().toUpperCase();
  if (!deviceCode) return res.json({ revoked: false });
  res.json({ revoked: !!revokedDevices[deviceCode] });
});

/* ============================ ADMIN : GÉNÉRER UNE LICENCE MANUELLEMENT ============================ */
app.post('/admin/generate', requireAdminAuth, (req, res) => {
  const deviceCode = (req.body.deviceCode || '').toString().trim().toUpperCase();
  const renewalIndex = parseInt(req.body.renewalIndex, 10) || 1;
  const planType = req.body.planType === '1M' ? '1M' : '1A';

  if (!deviceCode) return res.redirect('/admin');
  if (!LICENSE_SECRET) return res.redirect('/admin?error=' + encodeURIComponent("LICENSE_SECRET non configuré sur le serveur."));

  const key = computeActivationKey(deviceCode, renewalIndex, planType, LICENSE_SECRET);
  licensesLog.push({
    deviceCode, renewalIndex, planType, key,
    generatedAt: new Date().toISOString().slice(0, 10),
    source: 'manuel'
  });
  saveLicenses(licensesLog);

  res.redirect('/admin?generatedKey=' + encodeURIComponent(key) + '&generatedCode=' + encodeURIComponent(deviceCode));
});

/* ============================ ADMIN : PAGE UNIFIÉE ============================ */
app.get('/admin', requireAdminAuth, (req, res) => {
  const generatedKey = req.query.generatedKey || '';
  const generatedCode = req.query.generatedCode || '';
  const errorMsg = req.query.error || '';

  const revokedRows = Object.keys(revokedDevices).sort().map(code => `
    <tr>
      <td>${escapeHtml(code)}</td>
      <td>${escapeHtml(revokedDevices[code].revokedAt || '')}</td>
      <td>
        <form method="POST" action="/admin/unrevoke" style="margin:0;">
          <input type="hidden" name="deviceCode" value="${escapeHtml(code)}">
          <button type="submit" style="width:auto;margin:0;padding:6px 14px;font-size:12.5px;background:#C4432B;color:#fff;">Réactiver</button>
        </form>
      </td>
    </tr>`).join('');

  const statusPill = (s) => {
    const map = {
      active: '<span style="background:#E4F3EA;color:#2E8B57;padding:3px 10px;border-radius:20px;font-size:11.5px;font-weight:700;">Active</span>',
      suspendue: '<span style="background:#FBE7E2;color:#C4432B;padding:3px 10px;border-radius:20px;font-size:11.5px;font-weight:700;">Suspendue</span>',
      expiree: '<span style="background:#EFEFEF;color:#666;padding:3px 10px;border-radius:20px;font-size:11.5px;font-weight:700;">Expirée</span>'
    };
    return map[s] || s;
  };

  const sortedLicenses = [...licensesLog].sort((a, b) => (b.generatedAt || '').localeCompare(a.generatedAt || ''));
  const licenseRows = sortedLicenses.map(entry => {
    const status = licenseStatus(entry);
    return `
    <tr>
      <td>${escapeHtml(entry.deviceCode)}</td>
      <td>${PLAN_LABELS[entry.planType] || entry.planType}</td>
      <td>n°${escapeHtml(String(entry.renewalIndex))}</td>
      <td>${escapeHtml(entry.generatedAt)}</td>
      <td>${escapeHtml(estimatedExpiry(entry))}</td>
      <td>${entry.source === 'paiement' ? '💳 Paiement' : '✋ Manuel'}</td>
      <td>${statusPill(status)}</td>
    </tr>`;
  }).join('');

  res.send(`<!DOCTYPE html>
<html lang="fr">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Devis Pro — Administration</title>${SHARED_STYLE}
<style>
  .card{ max-width:900px; }
  .section{ border-top:1px solid var(--border); margin-top:26px; padding-top:22px; }
  .section:first-of-type{ border-top:none; margin-top:0; padding-top:0; }
  table.admin-table{ width:100%; border-collapse:collapse; margin-top:12px; font-size:13px; }
  table.admin-table th{ text-align:left; padding:8px 6px; font-size:11px; color:var(--muted); text-transform:uppercase; border-bottom:2px solid var(--border); }
  table.admin-table td{ padding:8px 6px; border-bottom:1px solid var(--border); }
  .row2{ display:flex; gap:10px; }
  .row2 > *{ flex:1; }
</style>
</head>
<body>
<div class="card">
  <h1>📋 Devis Pro — Administration des licences</h1>
  <div class="sub">Générez, suspendez, et suivez toutes les licences émises.</div>

  ${errorMsg ? `<div class="error" style="display:block;">${escapeHtml(errorMsg)}</div>` : ''}

  <div class="section">
    <h2 style="font-size:15px;color:var(--navy);">🔑 Générer une licence</h2>
    <form method="POST" action="/admin/generate">
      <label>Code appareil</label>
      <input type="text" name="deviceCode" placeholder="Ex : AB3D-9F2K" required>
      <div class="row2">
        <div>
          <label>Numéro de renouvellement</label>
          <input type="number" name="renewalIndex" min="1" value="1" required>
        </div>
        <div>
          <label>Type de licence</label>
          <select name="planType" style="text-transform:none;">
            <option value="1M">1 mois</option>
            <option value="1A" selected>1 an</option>
          </select>
        </div>
      </div>
      <button type="submit">Générer la clé</button>
    </form>
    ${generatedKey ? `
    <div class="result" style="display:block;">
      ${generatedKey}
      <div style="font-size:11.5px;color:var(--muted);font-weight:400;margin-top:8px;">Pour l'appareil ${escapeHtml(generatedCode)}</div>
    </div>` : ''}
  </div>

  <div class="section">
    <h2 style="font-size:15px;color:var(--navy);">🚫 Suspendre une licence</h2>
    <div class="sub">Effet uniquement si l'appareil du client a internet au prochain lancement de l'app.</div>
    <form method="POST" action="/admin/revoke">
      <label>Code appareil à suspendre</label>
      <input type="text" name="deviceCode" placeholder="Ex : AB3D-9F2K" required>
      <button type="submit">Suspendre cette licence</button>
    </form>

    <div style="margin-top:24px;">
      <label style="margin-top:0;">Licences actuellement suspendues (${Object.keys(revokedDevices).length})</label>
      ${Object.keys(revokedDevices).length === 0 ? '<div class="sub">Aucune licence suspendue actuellement.</div>' : `
      <table class="admin-table">
        <tr><th>Code appareil</th><th>Suspendu le</th><th></th></tr>
        ${revokedRows}
      </table>`}
    </div>
  </div>

  <div class="section">
    <h2 style="font-size:15px;color:var(--navy);">📄 Liste des licences générées (${licensesLog.length})</h2>
    ${licensesLog.length === 0 ? '<div class="sub">Aucune licence générée pour le moment.</div>' : `
    <div style="overflow-x:auto;">
    <table class="admin-table">
      <tr><th>Code appareil</th><th>Plan</th><th>Renouv.</th><th>Générée le</th><th>Expire le (estimé)</th><th>Origine</th><th>Statut</th></tr>
      ${licenseRows}
    </table>
    </div>
    <div class="note" style="text-align:left;margin-top:10px;">La date d'expiration est estimée à partir de la date de génération/paiement + durée du plan — elle suppose que le client active sa clé peu après. C'est une estimation, pas une valeur garantie à 100%.</div>
    `}
  </div>
</div>
</body>
</html>`);
});

app.post('/admin/revoke', requireAdminAuth, (req, res) => {
  const deviceCode = (req.body.deviceCode || '').toString().trim().toUpperCase();
  if (deviceCode) {
    revokedDevices[deviceCode] = { revokedAt: new Date().toISOString().slice(0, 16).replace('T', ' ') };
    saveRevoked(revokedDevices);
  }
  res.redirect('/admin');
});

app.post('/admin/unrevoke', requireAdminAuth, (req, res) => {
  const deviceCode = (req.body.deviceCode || '').toString().trim().toUpperCase();
  delete revokedDevices[deviceCode];
  saveRevoked(revokedDevices);
  res.redirect('/admin');
});

/* ============================ DÉMARRAGE ============================ */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Devis Pro - serveur de paiement démarré sur le port ${PORT}`);
  if (!FEDAPAY_SECRET_KEY) console.warn('⚠️  FEDAPAY_SECRET_KEY non définie — les paiements ne fonctionneront pas.');
  if (!FEDAPAY_WEBHOOK_SECRET) console.warn('⚠️  FEDAPAY_WEBHOOK_SECRET non définie — les webhooks échoueront.');
  if (!LICENSE_SECRET) console.warn('⚠️  LICENSE_SECRET non définie — les clés générées seront incorrectes.');
  if (!PUBLIC_BASE_URL) console.warn('⚠️  PUBLIC_BASE_URL non définie — le retour après paiement ne fonctionnera pas correctement.');
});
