
require('dotenv').config();

const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');

const app = express();
const PORT = Number(process.env.PORT || 10000);
const JWT_SECRET = process.env.JWT_SECRET || 'CHANGE_ME_NOW';

if (JWT_SECRET === 'CHANGE_ME_NOW') {
  console.warn('WARNING: JWT_SECRET is not set. Set it in Render before production.');
}

const allowedOrigins = (process.env.CORS_ORIGINS || '*')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

app.use(cors({
  origin(origin, cb) {
    if (!origin || allowedOrigins.includes('*') || allowedOrigins.includes(origin)) {
      return cb(null, true);
    }
    return cb(new Error('CORS blocked for this origin'));
  },
  credentials: true
}));

app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true, limit: '2mb' }));

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: String(process.env.PGSSL || 'true').toLowerCase() === 'true'
    ? { rejectUnauthorized: false }
    : false,
  max: 10,
  idleTimeoutMillis: 30000
});

function signUser(user) {
  return jwt.sign(
    { sub: String(user.id), role: user.role, email: user.email || null, phone: user.phone || null },
    JWT_SECRET,
    { expiresIn: '30d' }
  );
}

function normalizeUser(row) {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    phone: row.phone,
    role: row.role,
    wallet: Number(row.wallet_balance || 0),
    wallet_balance: Number(row.wallet_balance || 0),
    created_at: row.created_at
  };
}

async function auth(req, res, next) {
  try {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    if (!token) return res.status(401).json({ error: 'Authentication required' });

    const payload = jwt.verify(token, JWT_SECRET);
    const { rows } = await pool.query(
      'SELECT * FROM users WHERE id = $1 LIMIT 1',
      [payload.sub]
    );
    if (!rows[0]) return res.status(401).json({ error: 'User not found' });

    req.user = rows[0];
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

function adminOnly(req, res, next) {
  if (req.user?.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
}

async function initDb() {
  const schema = require('fs').readFileSync(require('path').join(__dirname, 'schema.sql'), 'utf8');
  await pool.query(schema);

  const adminEmail = (process.env.ADMIN_EMAIL || '').trim().toLowerCase();
  const adminPassword = process.env.ADMIN_PASSWORD || '';
  if (!adminEmail || !adminPassword) {
    console.warn('ADMIN_EMAIL/ADMIN_PASSWORD not set. Admin auto-create skipped.');
    return;
  }

  const hash = await bcrypt.hash(adminPassword, 12);
  await pool.query(`
    INSERT INTO users(name,email,phone,password_hash,role)
    VALUES($1,$2,$3,$4,'admin')
    ON CONFLICT (email)
    DO UPDATE SET
      name = EXCLUDED.name,
      phone = EXCLUDED.phone,
      password_hash = EXCLUDED.password_hash,
      role = 'admin'
  `, [
    process.env.ADMIN_NAME || 'FLEX TUPUP Admin',
    adminEmail,
    (process.env.ADMIN_PHONE || '').trim() || null,
    hash
  ]);
}

// Health
app.get('/health', async (_req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ ok: true, service: 'flex-tupup-backend', database: 'connected' });
  } catch {
    res.status(503).json({ ok: false, service: 'flex-tupup-backend', database: 'unavailable' });
  }
});

// ---------- AUTH ----------
app.post(['/api/auth/register', '/api/register'], async (req, res) => {
  try {
    const name = String(req.body.name || 'Client FLEX').trim();
    const email = String(req.body.email || '').trim().toLowerCase() || null;
    const phone = String(req.body.phone || req.body.contact || '').trim() || null;
    const password = String(req.body.password || '');

    if (!email && !phone) return res.status(400).json({ error: 'Email or phone required' });
    if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });

    const hash = await bcrypt.hash(password, 12);
    const { rows } = await pool.query(`
      INSERT INTO users(name,email,phone,password_hash,role)
      VALUES($1,$2,$3,$4,'client')
      RETURNING *
    `, [name, email, phone, hash]);

    const user = normalizeUser(rows[0]);
    res.status(201).json({ token: signUser(rows[0]), access_token: signUser(rows[0]), user });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Email or phone already exists' });
    console.error(err);
    res.status(500).json({ error: 'Registration failed' });
  }
});

app.post(['/api/auth/login', '/api/login', '/api/admin/login'], async (req, res) => {
  try {
    const login = String(
      req.body.email || req.body.username || req.body.phone || req.body.contact || ''
    ).trim().toLowerCase();
    const password = String(req.body.password || '');

    if (!login || !password) return res.status(400).json({ error: 'Login and password required' });

    const { rows } = await pool.query(`
      SELECT * FROM users
      WHERE LOWER(COALESCE(email,'')) = $1
         OR LOWER(COALESCE(phone,'')) = $1
      LIMIT 1
    `, [login]);

    if (!rows[0]) return res.status(401).json({ error: 'Invalid credentials' });

    const ok = await bcrypt.compare(password, rows[0].password_hash);
    if (!ok) return res.status(401).json({ error: 'Invalid credentials' });

    const token = signUser(rows[0]);
    res.json({
      token,
      access_token: token,
      user: normalizeUser(rows[0])
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Login failed' });
  }
});

app.get(['/api/me', '/api/auth/me'], auth, async (req, res) => {
  res.json({ user: normalizeUser(req.user) });
});

// ---------- WALLET ----------
app.get('/api/wallet', auth, async (req, res) => {
  const userResult = await pool.query(
    'SELECT wallet_balance FROM users WHERE id = $1',
    [req.user.id]
  );
  const deposits = await pool.query(`
    SELECT id, method, payment_method, amount, transaction_reference,
           transaction_reference AS tx, phone, sender_phone, note, status, created_at
    FROM wallet_deposits
    WHERE user_id = $1
    ORDER BY id DESC
    LIMIT 100
  `, [req.user.id]);

  res.json({
    wallet: {
      balance: Number(userResult.rows[0]?.wallet_balance || 0),
      deposits: deposits.rows
    },
    balance: Number(userResult.rows[0]?.wallet_balance || 0),
    deposits: deposits.rows
  });
});

// IMPORTANT: this is the route missing in the screenshot.
// The frontend sends POST /api/wallet/deposits with the transaction details.
app.post('/api/wallet/deposits', auth, async (req, res) => {
  const method = String(req.body.method || req.body.payment_method || '').trim();
  const amount = Number(req.body.amount);
  const tx = String(
    req.body.transaction_reference ||
    req.body.tx ||
    req.body.reference ||
    ''
  ).trim();
  const phone = String(req.body.phone || req.body.sender_phone || req.body.senderPhone || '').trim();
  const note = String(req.body.note || '').trim();

  if (!['MonCash', 'NatCash'].includes(method)) {
    return res.status(400).json({ error: 'Invalid payment method' });
  }
  if (!Number.isFinite(amount) || amount <= 0) {
    return res.status(400).json({ error: 'Invalid amount' });
  }
  if (tx.length < 4) {
    return res.status(400).json({ error: 'Transaction reference is required' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const duplicate = await client.query(`
      SELECT id, status
      FROM wallet_deposits
      WHERE user_id = $1 AND transaction_reference = $2
      LIMIT 1
    `, [req.user.id, tx]);

    if (duplicate.rows[0]) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        error: 'This transaction reference has already been submitted',
        deposit_id: duplicate.rows[0].id,
        status: duplicate.rows[0].status
      });
    }

    const inserted = await client.query(`
      INSERT INTO wallet_deposits(
        user_id, method, payment_method, amount,
        transaction_reference, phone, sender_phone, note, status
      )
      VALUES($1,$2,$2,$3,$4,$5,$5,$6,'pending')
      RETURNING id, user_id, method, payment_method, amount,
                transaction_reference, transaction_reference AS tx,
                phone, sender_phone, note, status, created_at
    `, [req.user.id, method, amount, tx, phone || null, note || null]);

    const deposit = inserted.rows[0];

    await client.query(`
      INSERT INTO notifications(user_id,type,title,message)
      VALUES($1,'wallet_deposit','Recharge Wallet reçue',$2)
    `, [
      req.user.id,
      `Votre demande de recharge de ${Number(deposit.amount).toLocaleString('fr-FR')} HTG via ${deposit.method} est en attente de validation.`
    ]);

    await client.query('COMMIT');

    res.status(201).json({
      ok: true,
      deposit: {
        ...deposit,
        amount: Number(deposit.amount)
      }
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Could not create wallet deposit' });
  } finally {
    client.release();
  }
});

app.get('/api/wallet/deposits', auth, async (req, res) => {
  const { rows } = await pool.query(`
    SELECT id, method, payment_method, amount, transaction_reference,
           transaction_reference AS tx, phone, sender_phone, note, status, created_at,
           reviewed_at
    FROM wallet_deposits
    WHERE user_id = $1
    ORDER BY id DESC
    LIMIT 100
  `, [req.user.id]);

  res.json({ deposits: rows });
});

// Admin: list all deposits
app.get('/api/admin/deposits', auth, adminOnly, async (_req, res) => {
  const { rows } = await pool.query(`
    SELECT d.id, d.user_id, u.name, u.email, u.phone AS user_phone,
           d.method, d.payment_method, d.amount,
           d.transaction_reference, d.transaction_reference AS tx,
           d.phone, d.sender_phone, d.note, d.status,
           d.created_at, d.reviewed_at
    FROM wallet_deposits d
    LEFT JOIN users u ON u.id = d.user_id
    ORDER BY d.id DESC
    LIMIT 500
  `);

  res.json({ deposits: rows.map(r => ({ ...r, amount: Number(r.amount) })) });
});

async function reviewDeposit(req, res, forcedStatus) {
  const depositId = Number(req.params.id);
  if (!Number.isInteger(depositId)) return res.status(400).json({ error: 'Invalid deposit id' });

  const status = forcedStatus || String(req.body.status || '');
  if (!['confirmed', 'refused'].includes(status)) {
    return res.status(400).json({ error: 'Status must be confirmed or refused' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const dep = await client.query(`
      SELECT * FROM wallet_deposits
      WHERE id = $1
      FOR UPDATE
    `, [depositId]);

    if (!dep.rows[0]) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Deposit not found' });
    }

    const d = dep.rows[0];

    if (d.status !== 'pending') {
      await client.query('ROLLBACK');
      return res.status(409).json({
        error: 'Deposit already reviewed',
        deposit: {
          ...d,
          amount: Number(d.amount)
        }
      });
    }

    // Only a confirmed deposit credits the wallet.
    if (status === 'confirmed') {
      const userResult = await client.query(`
        SELECT wallet_balance FROM users
        WHERE id = $1
        FOR UPDATE
      `, [d.user_id]);

      const before = Number(userResult.rows[0]?.wallet_balance || 0);
      const after = before + Number(d.amount);

      await client.query(`
        UPDATE users
        SET wallet_balance = $1
        WHERE id = $2
      `, [after, d.user_id]);

      await client.query(`
        INSERT INTO wallet_ledger(
          user_id, deposit_id, type, amount, balance_after, description
        )
        VALUES($1,$2,'credit',$3,$4,$5)
      `, [
        d.user_id,
        d.id,
        Number(d.amount),
        after,
        `Recharge ${d.method} confirmée • ${d.transaction_reference}`
      ]);
    }

    const updated = await client.query(`
      UPDATE wallet_deposits
      SET status = $1, reviewed_at = NOW(), reviewed_by = $2
      WHERE id = $3
      RETURNING id, user_id, method, payment_method, amount,
                transaction_reference, transaction_reference AS tx,
                phone, sender_phone, note, status, created_at, reviewed_at
    `, [status, req.user.id, d.id]);

    await client.query(`
      INSERT INTO notifications(user_id,type,title,message)
      VALUES($1,'wallet_deposit_status',$2,$3)
    `, [
      d.user_id,
      status === 'confirmed' ? 'Recharge Wallet confirmée' : 'Recharge Wallet refusée',
      status === 'confirmed'
        ? `Votre recharge de ${Number(d.amount).toLocaleString('fr-FR')} HTG a été confirmée.`
        : `Votre recharge de ${Number(d.amount).toLocaleString('fr-FR')} HTG a été refusée.`
    ]);

    await client.query('COMMIT');

    res.json({
      ok: true,
      deposit: {
        ...updated.rows[0],
        amount: Number(updated.rows[0].amount)
      }
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Could not review deposit' });
  } finally {
    client.release();
  }
}

app.patch('/api/admin/deposits/:id', auth, adminOnly, (req, res) => reviewDeposit(req, res));
app.post('/api/admin/deposits/:id/confirm', auth, adminOnly, (req, res) => reviewDeposit(req, res, 'confirmed'));
app.post('/api/admin/deposits/:id/refuse', auth, adminOnly, (req, res) => reviewDeposit(req, res, 'refused'));

// Extra frontend-compatible fallback for the admin's current code.
app.patch('/api/wallet/deposits/:id', auth, adminOnly, (req, res) => reviewDeposit(req, res));

// ---------- SETTINGS ----------
app.get(['/api/payment-settings', '/api/admin/payment-settings'], auth, async (req, res) => {
  const { rows } = await pool.query('SELECT moncash, natcash, whatsapp FROM payment_settings WHERE id = 1');
  const x = rows[0] || { moncash: '', natcash: '50956701079', whatsapp: '' };
  res.json(x);
});

app.put('/api/admin/payment-settings', auth, adminOnly, async (req, res) => {
  const moncash = String(
    req.body.moncash?.number ?? req.body.moncash ?? ''
  ).trim();
  const natcash = String(
    req.body.natcash?.number ?? req.body.natcash ?? process.env.NATCASH_NUMBER ?? '50956701079'
  ).trim();
  const whatsapp = String(req.body.whatsapp ?? req.body.wa ?? '').trim();

  const { rows } = await pool.query(`
    UPDATE payment_settings
    SET moncash = $1, natcash = $2, whatsapp = $3, updated_at = NOW()
    WHERE id = 1
    RETURNING *
  `, [moncash, natcash, whatsapp]);

  res.json(rows[0]);
});

// ---------- NOTIFICATIONS ----------
app.get('/api/notifications', auth, async (req, res) => {
  const { rows } = await pool.query(`
    SELECT id, type, title, message, read, created_at
    FROM notifications
    WHERE user_id = $1
    ORDER BY id DESC
    LIMIT 100
  `, [req.user.id]);
  res.json({ notifications: rows });
});

app.post('/api/admin/notifications', auth, adminOnly, async (req, res) => {
  const title = String(req.body.title || 'Notification admin');
  const message = String(req.body.message || '');
  const userId = Number(req.body.user_id || req.body.userId);

  if (Number.isInteger(userId) && userId > 0) {
    const { rows } = await pool.query(`
      INSERT INTO notifications(user_id,type,title,message)
      VALUES($1,$2,$3,$4)
      RETURNING *
    `, [userId, req.body.type || 'admin', title, message]);
    return res.status(201).json({ notification: rows[0] });
  }

  res.status(400).json({ error: 'user_id required for notification' });
});

// ---------- ORDERS ----------
app.get('/api/orders', auth, async (req, res) => {
  const { rows } = await pool.query(`
    SELECT id, user_id, game, pack, plan, price, amount,
           uid, player_id, account_name, phone, customer_phone,
           customer_contact, referral, payment, payment_method,
           status, created_at
    FROM orders
    WHERE user_id = $1
    ORDER BY id DESC
    LIMIT 100
  `, [req.user.id]);

  res.json({ orders: rows.map(r => ({ ...r, price: Number(r.price), amount: Number(r.amount) })) });
});

app.post('/api/orders', auth, async (req, res) => {
  const game = String(req.body.game || '').trim();
  const pack = String(req.body.pack || req.body.plan || '').trim();
  const amount = Number(req.body.amount ?? req.body.price ?? 0);
  const price = Number(req.body.price ?? amount);

  if (!game || !pack) return res.status(400).json({ error: 'Game and pack are required' });

  const { rows } = await pool.query(`
    INSERT INTO orders(
      user_id, game, pack, plan, price, amount, uid, player_id,
      account_name, phone, customer_phone, customer_contact,
      referral, payment, payment_method, status
    )
    VALUES($1,$2,$3,$3,$4,$5,$6,$7,$8,$9,$9,$10,$11,$12,$13,'En attente')
    RETURNING *
  `, [
    req.user.id,
    game,
    pack,
    price,
    amount,
    req.body.uid || req.body.playerId || req.body.player_id || null,
    req.body.player_id || req.body.playerId || req.body.uid || null,
    req.body.accountName || req.body.account_name || null,
    req.body.phone || req.body.customerPhone || req.body.customer_contact || null,
    req.body.customerContact || req.body.customer_contact || req.body.phone || null,
    req.body.referral || null,
    req.body.payment || 'Wallet',
    req.body.payment_method || 'Wallet'
  ]);

  res.status(201).json({
    order: {
      ...rows[0],
      price: Number(rows[0].price),
      amount: Number(rows[0].amount)
    }
  });
});

app.get('/api/admin/orders', auth, adminOnly, async (_req, res) => {
  const { rows } = await pool.query(`
    SELECT o.*, u.name AS customer, u.email, u.phone AS user_phone
    FROM orders o
    LEFT JOIN users u ON u.id = o.user_id
    ORDER BY o.id DESC
    LIMIT 500
  `);
  res.json({ orders: rows.map(r => ({ ...r, price: Number(r.price), amount: Number(r.amount) })) });
});

app.patch('/api/admin/orders/:id', auth, adminOnly, async (req, res) => {
  const id = Number(req.params.id);
  const status = String(req.body.status || '').trim();
  const allowed = ['En attente', 'En cours', 'Terminé', 'Refusé'];
  if (!Number.isInteger(id) || !allowed.includes(status)) {
    return res.status(400).json({ error: 'Invalid order or status' });
  }

  const { rows } = await pool.query(`
    UPDATE orders SET status = $1 WHERE id = $2 RETURNING *
  `, [status, id]);

  if (!rows[0]) return res.status(404).json({ error: 'Order not found' });
  res.json({ order: rows[0] });
});

// ---------- USERS ----------
app.get('/api/admin/users', auth, adminOnly, async (_req, res) => {
  const { rows } = await pool.query(`
    SELECT id, name, email, phone, role, wallet_balance, created_at
    FROM users
    ORDER BY id DESC
    LIMIT 1000
  `);
  res.json({ users: rows.map(normalizeUser) });
});

// ---------- GAMES / PACKS ----------
app.get('/api/games', async (_req, res) => {
  const { rows } = await pool.query(`
    SELECT id, name, image, active, created_at
    FROM games
    WHERE active = TRUE
    ORDER BY id ASC
  `);
  res.json({ games: rows });
});

app.get('/api/games/:id/packs', async (req, res) => {
  const { rows } = await pool.query(`
    SELECT id, game_id, name, qty, price, category, image, active, popular, premium
    FROM game_packs
    WHERE game_id = $1 AND active = TRUE
    ORDER BY id ASC
  `, [req.params.id]);
  res.json({ packs: rows.map(r => ({ ...r, qty: Number(r.qty), price: Number(r.price) })) });
});

app.get('/api/admin/games', auth, adminOnly, async (_req, res) => {
  const { rows } = await pool.query(`
    SELECT id, name, image, active, created_at
    FROM games
    ORDER BY id ASC
  `);
  res.json({ games: rows });
});

app.post('/api/admin/games', auth, adminOnly, async (req, res) => {
  const name = String(req.body.name || '').trim();
  const image = String(req.body.image || '').trim();
  if (!name) return res.status(400).json({ error: 'Game name required' });

  const { rows } = await pool.query(`
    INSERT INTO games(name,image)
    VALUES($1,$2)
    ON CONFLICT (name) DO UPDATE SET image = EXCLUDED.image
    RETURNING *
  `, [name, image]);

  res.status(201).json({ game: rows[0] });
});

app.post('/api/admin/games/:gameId/packs', auth, adminOnly, async (req, res) => {
  const { rows } = await pool.query(`
    INSERT INTO game_packs(game_id,name,qty,price,category,image,active,popular,premium)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
    RETURNING *
  `, [
    req.params.gameId,
    String(req.body.name || req.body.title || 'Pack'),
    Number(req.body.qty ?? req.body.quantity ?? 0),
    Number(req.body.price ?? 0),
    String(req.body.category || 'Plans'),
    String(req.body.image || req.body.img || ''),
    req.body.active !== false,
    !!req.body.popular,
    !!req.body.premium
  ]);

  res.status(201).json({ pack: rows[0] });
});

// ---------- MEDIA ----------
app.get('/api/admin/media', auth, adminOnly, async (_req, res) => {
  const { rows } = await pool.query('SELECT home, games FROM site_media WHERE id = 1');
  res.json(rows[0] || { home: '', games: {} });
});

app.put('/api/admin/media', auth, adminOnly, async (req, res) => {
  const home = String(req.body.home || '');
  const games = req.body.games && typeof req.body.games === 'object' ? req.body.games : {};

  const { rows } = await pool.query(`
    UPDATE site_media
    SET home = $1, games = $2::jsonb, updated_at = NOW()
    WHERE id = 1
    RETURNING home, games, updated_at
  `, [home, JSON.stringify(games)]);

  res.json(rows[0]);
});

// ---------- Error handling ----------
app.use((err, _req, res, _next) => {
  console.error(err);
  if (err.message === 'CORS blocked for this origin') {
    return res.status(403).json({ error: err.message });
  }
  res.status(500).json({ error: 'Internal server error' });
});

async function start() {
  await initDb();
  app.listen(PORT, () => {
    console.log(`FLEX TUPUP backend listening on port ${PORT}`);
    console.log(`Health: /health`);
  });
}

start().catch(err => {
  console.error('Startup failed:', err);
  process.exit(1);
});
