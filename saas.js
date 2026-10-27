/**
 * Devis Pro — module SaaS : comptes clients + synchronisation des données
 * ----------------------------------------------------------------------
 * - Chaque client crée un compte (e-mail + mot de passe) depuis l'application.
 * - Ses devis, factures, articles et entreprises sont sauvegardés sur ce serveur
 *   (PostgreSQL) et synchronisés entre tous ses appareils (téléphone, PC, web).
 * - L'application reste 100 % utilisable hors-ligne : elle synchronise dès que
 *   la connexion revient.
 * - La licence reste liée à l'appareil (clé d'activation) : ce module ne gère
 *   QUE les comptes et les données.
 *
 * Variables d'environnement (.env) :
 *   DATABASE_URL = postgres://devispro:MOT_DE_PASSE@localhost:5432/devispro
 *   SAAS_SECRET  = longue chaîne aléatoire (signature des connexions)
 */
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const express = require('express');

const KINDS = ['devis', 'entreprise', 'article', 'meta'];
const TOKEN_DAYS = 365;
const PULL_LIMIT = 300;

module.exports = function setupSaas(app, { requireAdminAuth, escapeHtml }) {
  const DATABASE_URL = process.env.DATABASE_URL || '';
  const SAAS_SECRET = process.env.SAAS_SECRET ||
    crypto.createHash('sha256').update('devispro-saas|' + (process.env.ADMIN_PASSWORD || '') + '|' + (process.env.LICENSE_SECRET || '')).digest('hex');

  let pool = null;
  let dbReady = false;
  if (DATABASE_URL) {
    try {
      const { Pool } = require('pg');
      pool = new Pool({ connectionString: DATABASE_URL, max: 10 });
      initSchema().then(() => {
        dbReady = true;
        console.log('SaaS : base PostgreSQL prête.');
      }).catch(e => console.error('SaaS : erreur initialisation base :', e.message));
    } catch (e) {
      console.error('SaaS : module "pg" absent — lancez "npm install".', e.message);
    }
  } else {
    console.warn('⚠️  DATABASE_URL non définie — comptes et synchronisation désactivés.');
  }

  async function initSchema() {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS dp_users (
        id SERIAL PRIMARY KEY,
        email TEXT UNIQUE NOT NULL,
        pass_hash TEXT NOT NULL,
        token_version INT NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        last_sync TIMESTAMPTZ
      );
      CREATE SEQUENCE IF NOT EXISTS dp_rev_seq;
      CREATE TABLE IF NOT EXISTS dp_records (
        user_id INT NOT NULL REFERENCES dp_users(id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        id TEXT NOT NULL,
        data JSONB,
        updated_at BIGINT NOT NULL DEFAULT 0,
        deleted BOOLEAN NOT NULL DEFAULT false,
        rev BIGINT NOT NULL DEFAULT nextval('dp_rev_seq'),
        PRIMARY KEY (user_id, kind, id)
      );
      CREATE INDEX IF NOT EXISTS dp_records_rev ON dp_records (user_id, rev);
      CREATE INDEX IF NOT EXISTS dp_records_numero ON dp_records (user_id, (data->>'numero')) WHERE kind = 'devis';
    `);
  }

  /* ---------- Mots de passe (scrypt, sans dépendance externe) ---------- */
  function hashPassword(pw) {
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = crypto.scryptSync(pw, salt, 64).toString('hex');
    return `scrypt$${salt}$${hash}`;
  }
  function checkPassword(pw, stored) {
    const [algo, salt, hash] = String(stored || '').split('$');
    if (algo !== 'scrypt' || !salt || !hash) return false;
    const test = crypto.scryptSync(pw, salt, 64);
    const ref = Buffer.from(hash, 'hex');
    return ref.length === test.length && crypto.timingSafeEqual(ref, test);
  }

  /* ---------- Jetons de connexion signés ---------- */
  function b64url(buf) { return Buffer.from(buf).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_'); }
  function sign(payload) { return b64url(crypto.createHmac('sha256', SAAS_SECRET).update(payload).digest()); }
  function makeToken(user) {
    const payload = b64url(JSON.stringify({ u: user.id, v: user.token_version, exp: Date.now() + TOKEN_DAYS * 86400000 }));
    return payload + '.' + sign(payload);
  }
  async function userFromRequest(req) {
    const auth = req.headers.authorization || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    const [payload, sig] = token.split('.');
    if (!payload || !sig) return null;
    const expected = sign(payload);
    if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
    let data;
    try { data = JSON.parse(Buffer.from(payload.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')); } catch (e) { return null; }
    if (!data || !data.u || data.exp < Date.now()) return null;
    const r = await pool.query('SELECT id, email, token_version FROM dp_users WHERE id = $1', [data.u]);
    const user = r.rows[0];
    if (!user || user.token_version !== data.v) return null;
    return user;
  }

  /* ---------- Limitation des tentatives de connexion ---------- */
  const attempts = new Map();
  function tooManyAttempts(ip) {
    const now = Date.now();
    const a = attempts.get(ip) || { n: 0, t: now };
    if (now - a.t > 15 * 60000) { a.n = 0; a.t = now; }
    a.n++;
    attempts.set(ip, a);
    return a.n > 30;
  }

  /* ---------- API (CORS ouvert : appelée par les applis Android / iPhone / PC) ---------- */
  const api = express.Router();
  api.use((req, res, next) => {
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    if (!pool || !dbReady) return res.status(503).json({ error: 'Service de compte momentanément indisponible.' });
    next();
  });
  api.use(express.json({ limit: '20mb' }));

  const emailOk = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);

  api.post('/register', async (req, res) => {
    try {
      if (tooManyAttempts(req.ip)) return res.status(429).json({ error: 'Trop de tentatives. Réessayez dans 15 minutes.' });
      const email = String(req.body.email || '').trim().toLowerCase();
      const password = String(req.body.password || '');
      if (!emailOk(email)) return res.status(400).json({ error: 'Adresse e-mail invalide.' });
      if (password.length < 6) return res.status(400).json({ error: 'Le mot de passe doit contenir au moins 6 caractères.' });
      const exist = await pool.query('SELECT 1 FROM dp_users WHERE email = $1', [email]);
      if (exist.rows.length) return res.status(409).json({ error: 'Un compte existe déjà avec cet e-mail. Connectez-vous.' });
      const r = await pool.query('INSERT INTO dp_users (email, pass_hash) VALUES ($1, $2) RETURNING id, email, token_version', [email, hashPassword(password)]);
      res.json({ token: makeToken(r.rows[0]), email });
    } catch (e) {
      console.error('SaaS register :', e.message);
      res.status(500).json({ error: 'Erreur serveur.' });
    }
  });

  api.post('/login', async (req, res) => {
    try {
      if (tooManyAttempts(req.ip)) return res.status(429).json({ error: 'Trop de tentatives. Réessayez dans 15 minutes.' });
      const email = String(req.body.email || '').trim().toLowerCase();
      const password = String(req.body.password || '');
      const r = await pool.query('SELECT id, email, pass_hash, token_version FROM dp_users WHERE email = $1', [email]);
      const user = r.rows[0];
      if (!user || !checkPassword(password, user.pass_hash)) return res.status(401).json({ error: 'E-mail ou mot de passe incorrect.' });
      res.json({ token: makeToken(user), email: user.email });
    } catch (e) {
      console.error('SaaS login :', e.message);
      res.status(500).json({ error: 'Erreur serveur.' });
    }
  });

  api.post('/password', async (req, res) => {
    try {
      const user = await userFromRequest(req);
      if (!user) return res.status(401).json({ error: 'Session expirée. Reconnectez-vous.' });
      const r = await pool.query('SELECT pass_hash FROM dp_users WHERE id = $1', [user.id]);
      if (!checkPassword(String(req.body.oldPassword || ''), r.rows[0].pass_hash)) return res.status(400).json({ error: 'Mot de passe actuel incorrect.' });
      const pw = String(req.body.newPassword || '');
      if (pw.length < 6) return res.status(400).json({ error: 'Le nouveau mot de passe doit contenir au moins 6 caractères.' });
      const u = await pool.query('UPDATE dp_users SET pass_hash = $1, token_version = token_version + 1 WHERE id = $2 RETURNING id, email, token_version', [hashPassword(pw), user.id]);
      res.json({ token: makeToken(u.rows[0]) });
    } catch (e) {
      res.status(500).json({ error: 'Erreur serveur.' });
    }
  });

  /* ---------- Numérotation partagée entre les appareils d'un même compte ---------- */
  // Compteur stocké dans l'enregistrement meta/seq du compte : un seul compteur par
  // compte, verrouillé pendant l'attribution, donc jamais deux fois le même numéro.
  function fabriquerNumero(type, n) {
    const prefix = type === 'facture' ? 'FAC-' : 'DEV-';
    return prefix + new Date().getFullYear() + '-' + String(n).padStart(4, '0');
  }
  // Compteur global ('seq') ou par entreprise ('seq:<idEntreprise>')
  function metaSeqId(entId) { return entId ? 'seq:' + entId : 'seq'; }
  async function lireSeq(client, userId, metaId) {
    const cur = await client.query("SELECT data FROM dp_records WHERE user_id = $1 AND kind = 'meta' AND id = $2 FOR UPDATE", [userId, metaId || 'seq']);
    return { existe: !!cur.rows[0], data: Object.assign({ devis: 1, facture: 1 }, (cur.rows[0] && cur.rows[0].data) || {}) };
  }
  async function ecrireSeq(client, userId, data, metaId) {
    await client.query(`
      INSERT INTO dp_records (user_id, kind, id, data, updated_at, deleted) VALUES ($1, 'meta', $4, $2, $3, false)
      ON CONFLICT (user_id, kind, id) DO UPDATE SET data = EXCLUDED.data, updated_at = EXCLUDED.updated_at, deleted = false, rev = nextval('dp_rev_seq')`,
      [userId, JSON.stringify(data), Date.now(), metaId || 'seq']);
  }
  // Un numéro n'est unique qu'au sein d'une même entreprise (chaque entreprise a sa numérotation)
  async function numeroPris(client, userId, numero, saufId, entId) {
    const r = await client.query(
      "SELECT 1 FROM dp_records WHERE user_id = $1 AND kind = 'devis' AND NOT deleted AND data->>'numero' = $2 AND id <> $3 AND coalesce(data->>'entrepriseId','') = $4 LIMIT 1",
      [userId, numero, saufId, entId || '']);
    return r.rows.length > 0;
  }
  // Attribue le prochain numéro libre du type demandé et avance le compteur.
  async function attribuerNumero(client, userId, type, saufId, entId) {
    const metaId = metaSeqId(entId);
    const seq = await lireSeq(client, userId, metaId);
    let n = Math.max(1, parseInt(seq.data[type], 10) || 1);
    let numero = fabriquerNumero(type, n);
    while (await numeroPris(client, userId, numero, saufId || '', entId)) { n++; numero = fabriquerNumero(type, n); }
    seq.data[type] = n + 1;
    await ecrireSeq(client, userId, seq.data, metaId);
    return numero;
  }

  /**
   * Synchronisation.
   * Chaque modification envoyée indique la version du serveur sur laquelle elle a été
   * faite (baseRev). Si un AUTRE appareil a modifié le même élément entre-temps, rien
   * n'est écrasé : le serveur renvoie un « conflit » et l'utilisateur choisit quelle
   * version garder (ou les deux). Un document arrivant avec un numéro déjà utilisé
   * par un autre document du compte reçoit automatiquement le prochain numéro libre.
   */
  api.post('/sync', async (req, res) => {
    let client;
    try {
      const user = await userFromRequest(req);
      if (!user) return res.status(401).json({ error: 'Session expirée. Reconnectez-vous.' });
      const since = Math.max(0, parseInt(req.body.since, 10) || 0);
      const changes = Array.isArray(req.body.changes) ? req.body.changes : [];
      const acks = [], conflicts = [];

      client = await pool.connect();
      await client.query('BEGIN');
      for (const c of changes) {
        const kind = String(c.kind || '');
        const id = String(c.id || '');
        if (!KINDS.includes(kind) || !id || id.length > 120) continue;
        const updatedAt = Date.now();
        const deleted = !!c.deleted;
        const baseRev = Math.max(0, parseInt(c.baseRev, 10) || 0);

        if (kind === 'meta') {
          if (id === 'seq' || id.startsWith('seq:')) {
            // Numérotation : on garde toujours le plus grand compteur de chaque type.
            const seq = await lireSeq(client, user.id, id);
            const recu = (c.data && typeof c.data === 'object') ? c.data : {};
            let change = !seq.existe;
            Object.keys(recu).forEach(k => {
              const v = Math.max(parseInt(seq.data[k], 10) || 1, parseInt(recu[k], 10) || 1);
              if (v !== (parseInt(seq.data[k], 10) || 1)) { seq.data[k] = v; change = true; }
            });
            if (change) await ecrireSeq(client, user.id, seq.data, id);
          }
          acks.push({ kind, id, rev: 0 });
          continue;
        }

        const cur = await client.query('SELECT data, deleted, rev, updated_at FROM dp_records WHERE user_id = $1 AND kind = $2 AND id = $3 FOR UPDATE', [user.id, kind, id]);
        const ex = cur.rows[0];
        let data = deleted ? null : (c.data === undefined ? null : c.data);

        if (ex && Number(ex.rev) > baseRev) {
          // Modifié ailleurs depuis la dernière synchro de cet appareil
          const memeContenu = (ex.deleted && deleted) ||
            (!ex.deleted && !deleted && (await client.query('SELECT $1::jsonb = $2::jsonb AS eq', [JSON.stringify(ex.data), JSON.stringify(data)])).rows[0].eq);
          if (memeContenu) { acks.push({ kind, id, rev: Number(ex.rev) }); continue; }
          if (ex.deleted && !deleted) {
            // Supprimé sur un appareil, modifié sur un autre : on garde la version modifiée
          } else {
            conflicts.push({ kind, id, serverRev: Number(ex.rev), serverDeleted: ex.deleted, serverData: ex.data, serverUpdatedAt: Number(ex.updated_at) });
            continue;
          }
        }

        let renumerote = null;
        if (kind === 'devis' && !deleted && data && typeof data === 'object' && data.numero) {
          const entId = data.entrepriseId ? String(data.entrepriseId) : '';
          if (await numeroPris(client, user.id, String(data.numero), id, entId)) {
            const ancien = String(data.numero);
            data = Object.assign({}, data, { numero: await attribuerNumero(client, user.id, data.type === 'facture' ? 'facture' : 'devis', id, entId) });
            renumerote = { ancien, nouveau: data.numero };
          }
        }
        const w = await client.query(`
          INSERT INTO dp_records (user_id, kind, id, data, updated_at, deleted)
          VALUES ($1, $2, $3, $4, $5, $6)
          ON CONFLICT (user_id, kind, id) DO UPDATE
            SET data = EXCLUDED.data, updated_at = EXCLUDED.updated_at,
                deleted = EXCLUDED.deleted, rev = nextval('dp_rev_seq')
          RETURNING rev`,
          [user.id, kind, id, deleted ? null : JSON.stringify(data), updatedAt, deleted]);
        const ack = { kind, id, rev: Number(w.rows[0].rev) };
        if (renumerote) { ack.data = data; ack.renumerote = renumerote; }
        acks.push(ack);
      }
      await client.query('UPDATE dp_users SET last_sync = now() WHERE id = $1', [user.id]);
      await client.query('COMMIT');

      const r = await client.query(
        'SELECT kind, id, data, updated_at, deleted, rev FROM dp_records WHERE user_id = $1 AND rev > $2 ORDER BY rev LIMIT $3',
        [user.id, since, PULL_LIMIT]);
      const out = r.rows.map(x => ({ kind: x.kind, id: x.id, data: x.data, updatedAt: Number(x.updated_at), deleted: x.deleted, rev: Number(x.rev) }));
      const cursor = r.rows.length ? Number(r.rows[r.rows.length - 1].rev) : since;
      res.json({ acks, conflicts, changes: out, cursor, hasMore: r.rows.length === PULL_LIMIT, email: user.email });
    } catch (e) {
      if (client) { try { await client.query('ROLLBACK'); } catch (_) {} }
      console.error('SaaS sync :', e.message);
      res.status(500).json({ error: 'Erreur serveur pendant la synchronisation.' });
    } finally {
      if (client) client.release();
    }
  });

  app.use('/api/saas', api);

  /* ---------- Version web de l'application ---------- */
  const webApp = path.join(__dirname, 'public', 'electricien-devis.html');
  app.get('/app', (req, res) => {
    if (!fs.existsSync(webApp)) return res.status(404).send('Version web non installée (public/electricien-devis.html manquant).');
    res.set('Cache-Control', 'no-cache');
    res.sendFile(webApp);
  });

  /* ---------- Administration des comptes ---------- */
  app.get('/admin/comptes', requireAdminAuth, async (req, res) => {
    if (!pool || !dbReady) return res.send('Base PostgreSQL non configurée (DATABASE_URL).');
    const msg = req.query.msg ? `<div class="ok">${escapeHtml(String(req.query.msg))}</div>` : '';
    const q = String(req.query.q || '').trim().toLowerCase();
    const r = await pool.query(`
      SELECT u.id, u.email, u.created_at, u.last_sync,
        COUNT(*) FILTER (WHERE r.kind='devis' AND NOT r.deleted) AS docs,
        COUNT(*) FILTER (WHERE r.kind='entreprise' AND NOT r.deleted) AS ents
      FROM dp_users u LEFT JOIN dp_records r ON r.user_id = u.id
      ${q ? 'WHERE u.email LIKE $1' : ''}
      GROUP BY u.id ORDER BY u.created_at DESC LIMIT 500`, q ? ['%' + q + '%'] : []);
    const total = await pool.query('SELECT COUNT(*) AS n FROM dp_users');
    const fmt = (d) => d ? new Date(d).toLocaleString('fr-FR', { timeZone: 'Africa/Lome' }) : '—';
    const rows = r.rows.map(u => `
      <tr>
        <td><b>${escapeHtml(u.email)}</b><br><small>Créé le ${fmt(u.created_at)}</small></td>
        <td>${u.docs}</td><td>${u.ents}</td><td><small>${fmt(u.last_sync)}</small></td>
        <td>
          <form method="POST" action="/admin/comptes/password" class="inline">
            <input type="hidden" name="id" value="${u.id}">
            <input type="text" name="password" placeholder="Nouveau mot de passe" minlength="6" required>
            <button type="submit">Changer</button>
          </form>
          <form method="POST" action="/admin/comptes/delete" class="inline" onsubmit="return confirm('Supprimer définitivement le compte ${escapeHtml(u.email)} et toutes ses données ?');">
            <input type="hidden" name="id" value="${u.id}">
            <button type="submit" class="danger">Supprimer</button>
          </form>
        </td>
      </tr>`).join('');
    res.send(`<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Comptes Devis Pro</title>
<style>
  body{font-family:Segoe UI,Roboto,Arial,sans-serif;background:#F5F7FA;color:#16212E;margin:0;padding:16px;}
  .wrap{max-width:1000px;margin:0 auto;}
  h1{font-size:18px;color:#10233A;}
  a{color:#10233A;font-weight:700;}
  .card{background:#fff;border:1px solid #E1E5EA;border-radius:12px;padding:14px;margin-top:12px;overflow-x:auto;}
  table{width:100%;border-collapse:collapse;font-size:13px;}
  th,td{text-align:left;padding:8px 6px;border-bottom:1px solid #EDEFF2;vertical-align:top;}
  input{padding:7px;border:1px solid #E1E5EA;border-radius:7px;font-size:13px;}
  button{padding:7px 12px;border:none;border-radius:7px;background:#10233A;color:#fff;font-weight:700;cursor:pointer;font-size:12.5px;}
  button.danger{background:#C4432B;}
  form.inline{display:flex;gap:6px;margin:0 0 6px;flex-wrap:wrap;}
  .ok{background:#E4F3EA;color:#1F7A45;border-radius:8px;padding:10px;margin-top:12px;font-weight:700;}
  small{color:#5B6B7C;}
</style></head><body><div class="wrap">
  <a href="/admin">← Retour à l'administration</a>
  <h1>👥 Comptes clients (${total.rows[0].n})</h1>
  ${msg}
  <div class="card">
    <form method="GET" action="/admin/comptes" class="inline"><input type="text" name="q" value="${escapeHtml(q)}" placeholder="Rechercher un e-mail"><button type="submit">Rechercher</button></form>
    ${r.rows.length === 0 ? '<p><small>Aucun compte.</small></p>' : `
    <table><tr><th>Compte</th><th>Documents</th><th>Entreprises</th><th>Dernière synchro</th><th>Actions</th></tr>${rows}</table>`}
  </div>
  <p><small>« Changer » sert au client qui a oublié son mot de passe : communiquez-lui le nouveau. Ses appareils devront se reconnecter.</small></p>
</div></body></html>`);
  });

  app.post('/admin/comptes/password', requireAdminAuth, async (req, res) => {
    const id = parseInt(req.body.id, 10);
    const pw = String(req.body.password || '');
    if (!id || pw.length < 6) return res.redirect('/admin/comptes?msg=' + encodeURIComponent('Mot de passe trop court (6 caractères minimum).'));
    const r = await pool.query('UPDATE dp_users SET pass_hash = $1, token_version = token_version + 1 WHERE id = $2 RETURNING email', [hashPassword(pw), id]);
    res.redirect('/admin/comptes?msg=' + encodeURIComponent(r.rows[0] ? `Mot de passe changé pour ${r.rows[0].email}.` : 'Compte introuvable.'));
  });

  app.post('/admin/comptes/delete', requireAdminAuth, async (req, res) => {
    const id = parseInt(req.body.id, 10);
    const r = await pool.query('DELETE FROM dp_users WHERE id = $1 RETURNING email', [id]);
    res.redirect('/admin/comptes?msg=' + encodeURIComponent(r.rows[0] ? `Compte ${r.rows[0].email} supprimé.` : 'Compte introuvable.'));
  });
};
