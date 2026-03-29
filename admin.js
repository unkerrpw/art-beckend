// routes/admin.js — скрытая админ-панель
const router = require('express').Router();
const jwt = require('jsonwebtoken');
const db = require('../db');

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const ADMIN_SECRET = process.env.JWT_SECRET + '_admin';

// Middleware — проверка админ-токена
function requireAdmin(req, res, next) {
  const token = req.headers['x-admin-token'] || req.query.token;
  if (!token) return res.status(401).json({ error: 'Нет доступа' });
  try {
    jwt.verify(token, ADMIN_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Неверный токен' });
  }
}

// ===== POST /api/admin/login =====
router.post('/login', (req, res) => {
  const { password } = req.body;
  if (!password || password !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Неверный пароль' });
  }
  const token = jwt.sign({ admin: true }, ADMIN_SECRET, { expiresIn: '12h' });
  res.json({ token });
});

// ===== GET /api/admin/stats =====
router.get('/stats', requireAdmin, (req, res) => {
  const users = db.prepare('SELECT COUNT(*) as cnt FROM users').get();
  const verified = db.prepare('SELECT COUNT(*) as cnt FROM users WHERE is_verified = 1').get();
  const jobs = db.prepare('SELECT COUNT(*) as cnt FROM jobs').get();
  const openJobs = db.prepare("SELECT COUNT(*) as cnt FROM jobs WHERE status = 'open'").get();
  const pendingWithdraws = db.prepare("SELECT COUNT(*) as cnt FROM withdraw_requests WHERE status = 'pending'").get();
  const pendingWithdrawsAmt = db.prepare("SELECT SUM(amount_usd) as total FROM withdraw_requests WHERE status = 'pending'").get();
  const totalDeposited = db.prepare("SELECT SUM(amount) as total FROM transactions WHERE type = 'deposit' AND direction = 'in'").get();
  const totalWithdrawn = db.prepare("SELECT SUM(amount_usd) as total FROM withdraw_requests WHERE status = 'completed'").get();
  const todayUsers = db.prepare("SELECT COUNT(*) as cnt FROM users WHERE date(created_at) = date('now')").get();
  const todayJobs = db.prepare("SELECT COUNT(*) as cnt FROM jobs WHERE date(created_at) = date('now')").get();

  res.json({
    users: users.cnt,
    verified_users: verified.cnt,
    today_users: todayUsers.cnt,
    jobs: jobs.cnt,
    open_jobs: openJobs.cnt,
    today_jobs: todayJobs.cnt,
    pending_withdrawals: pendingWithdraws.cnt,
    pending_withdrawals_usd: pendingWithdrawsAmt.total || 0,
    total_deposited_usd: ((totalDeposited.total || 0) / 100).toFixed(2),
    total_withdrawn_usd: (totalWithdrawn.total || 0).toFixed(2),
  });
});

// ===== GET /api/admin/users =====
router.get('/users', requireAdmin, (req, res) => {
  const { page = 1, limit = 30, search } = req.query;
  const offset = (page - 1) * limit;
  let where = '';
  const params = [];
  if (search) { where = 'WHERE u.email LIKE ? OR u.first_name LIKE ? OR u.last_name LIKE ?'; const s = `%${search}%`; params.push(s, s, s); }

  const users = db.prepare(`
    SELECT u.id, u.uuid, u.email, u.first_name, u.last_name, u.role,
           u.is_verified, u.is_active, u.created_at,
           w.balance, w.total_earned, w.total_spent
    FROM users u LEFT JOIN wallets w ON w.user_id = u.id
    ${where}
    ORDER BY u.created_at DESC LIMIT ? OFFSET ?
  `).all(...params, Number(limit), Number(offset));

  const total = db.prepare(`SELECT COUNT(*) as cnt FROM users u ${where}`).get(...params);

  res.json({ users: users.map(u => ({ ...u, balance: (u.balance||0)/100, total_earned: (u.total_earned||0)/100 })), total: total.cnt });
});

// ===== PATCH /api/admin/users/:id/ban =====
router.patch('/users/:id/ban', requireAdmin, (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!user) return res.status(404).json({ error: 'Пользователь не найден' });
  const newStatus = user.is_active ? 0 : 1;
  db.prepare('UPDATE users SET is_active = ? WHERE id = ?').run(newStatus, user.id);
  res.json({ success: true, is_active: newStatus });
});

// ===== GET /api/admin/withdrawals =====
router.get('/withdrawals', requireAdmin, (req, res) => {
  const { status = 'pending' } = req.query;
  const requests = db.prepare(`
    SELECT wr.*, u.email, u.first_name, u.last_name
    FROM withdraw_requests wr
    JOIN users u ON u.id = wr.user_id
    WHERE wr.status = ?
    ORDER BY wr.created_at DESC
  `).all(status);
  res.json(requests);
});

// ===== PATCH /api/admin/withdrawals/:uuid/approve =====
router.patch('/withdrawals/:uuid/approve', requireAdmin, (req, res) => {
  const wr = db.prepare('SELECT * FROM withdraw_requests WHERE uuid = ?').get(req.params.uuid);
  if (!wr) return res.status(404).json({ error: 'Заявка не найдена' });
  if (wr.status !== 'pending') return res.status(400).json({ error: 'Заявка уже обработана' });

  const amountCents = Math.round(wr.amount_usd * 100);

  // Снимаем из эскроу
  db.prepare('UPDATE wallets SET escrow = escrow - ?, total_spent = total_spent + ? WHERE user_id = ?').run(amountCents, amountCents, wr.user_id);
  db.prepare("UPDATE withdraw_requests SET status = 'completed', processed_at = datetime('now') WHERE uuid = ?").run(wr.uuid);

  const { v4: uuidv4 } = require('uuid');
  db.prepare(`INSERT INTO transactions (uuid, user_id, type, amount, direction, description, status) VALUES (?, ?, 'withdrawal', ?, 'out', ?, 'completed')`)
    .run(uuidv4(), wr.user_id, amountCents, `Вывод ${wr.asset} на ${wr.address}`);

  db.prepare(`INSERT INTO notifications (user_id, type, title, body) VALUES (?, 'payment', ?, ?)`)
    .run(wr.user_id, 'Вывод выполнен!', `$${wr.amount_usd} ${wr.asset} отправлено на ${wr.address.slice(0,12)}...`);

  res.json({ success: true });
});

// ===== PATCH /api/admin/withdrawals/:uuid/reject =====
router.patch('/withdrawals/:uuid/reject', requireAdmin, (req, res) => {
  const wr = db.prepare('SELECT * FROM withdraw_requests WHERE uuid = ?').get(req.params.uuid);
  if (!wr) return res.status(404).json({ error: 'Заявка не найдена' });
  if (wr.status !== 'pending') return res.status(400).json({ error: 'Уже обработана' });

  const amountCents = Math.round(wr.amount_usd * 100);
  // Возвращаем средства на баланс
  db.prepare('UPDATE wallets SET balance = balance + ?, escrow = escrow - ? WHERE user_id = ?').run(amountCents, amountCents, wr.user_id);
  db.prepare("UPDATE withdraw_requests SET status = 'rejected', processed_at = datetime('now') WHERE uuid = ?").run(wr.uuid);

  db.prepare(`INSERT INTO notifications (user_id, type, title, body) VALUES (?, 'payment', ?, ?)`)
    .run(wr.user_id, 'Вывод отклонён', `Заявка на $${wr.amount_usd} ${wr.asset} отклонена. Средства возвращены на баланс.`);

  res.json({ success: true });
});

// ===== GET /api/admin/jobs =====
router.get('/jobs', requireAdmin, (req, res) => {
  const jobs = db.prepare(`
    SELECT j.*, u.email, u.first_name, u.last_name,
           COUNT(p.id) as proposals_count
    FROM jobs j
    JOIN users u ON u.id = j.client_id
    LEFT JOIN proposals p ON p.job_id = j.id
    GROUP BY j.id ORDER BY j.created_at DESC LIMIT 50
  `).all();
  jobs.forEach(j => j.tags = JSON.parse(j.tags || '[]'));
  res.json(jobs);
});

// ===== DELETE /api/admin/jobs/:uuid =====
router.delete('/jobs/:uuid', requireAdmin, (req, res) => {
  db.prepare('UPDATE jobs SET status = ? WHERE uuid = ?').run('cancelled', req.params.uuid);
  res.json({ success: true });
});

// ===== GET /api/admin/transactions =====
router.get('/transactions', requireAdmin, (req, res) => {
  const txs = db.prepare(`
    SELECT t.*, u.email, u.first_name, u.last_name
    FROM transactions t JOIN users u ON u.id = t.user_id
    ORDER BY t.created_at DESC LIMIT 100
  `).all();
  res.json(txs.map(t => ({ ...t, amount: t.amount / 100 })));
});

// ===== POST /api/admin/users/:id/adjust-balance =====
router.post('/users/:id/adjust-balance', requireAdmin, (req, res) => {
  const { amount_usd, reason } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!user) return res.status(404).json({ error: 'Пользователь не найден' });

  const amountCents = Math.round(parseFloat(amount_usd) * 100);
  const direction = amountCents > 0 ? 'in' : 'out';

  db.prepare('UPDATE wallets SET balance = balance + ? WHERE user_id = ?').run(Math.abs(amountCents) * (amountCents > 0 ? 1 : -1), user.id);

  const { v4: uuidv4 } = require('uuid');
  db.prepare(`INSERT INTO transactions (uuid, user_id, type, amount, direction, description, status) VALUES (?, ?, 'deposit', ?, ?, ?, 'completed')`)
    .run(uuidv4(), user.id, Math.abs(amountCents), direction, reason || 'Ручная корректировка администратором');

  res.json({ success: true });
});

module.exports = { adminRouter: router, requireAdmin };
