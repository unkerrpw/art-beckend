// routes/wallet.js
const router = require('express').Router();
const { v4: uuidv4 } = require('uuid');
const { requireAuth, requireVerified } = require('../middleware/auth');
const db = require('../db');

// GET /api/wallet
router.get('/', requireAuth, (req, res) => {
  const wallet = db.prepare('SELECT * FROM wallets WHERE user_id = ?').get(req.user.id);
  if (!wallet) return res.status(404).json({ error: 'Кошелёк не найден' });
  res.json({
    balance: wallet.balance / 100,          // в рублях
    escrow: wallet.escrow / 100,
    total_earned: wallet.total_earned / 100,
    total_spent: wallet.total_spent / 100,
  });
});

// GET /api/wallet/transactions
router.get('/transactions', requireAuth, (req, res) => {
  const { page = 1, limit = 30 } = req.query;
  const offset = (page - 1) * limit;
  const txs = db.prepare(`
    SELECT t.*, p.title as project_title
    FROM transactions t
    LEFT JOIN projects p ON p.id = t.project_id
    WHERE t.user_id = ?
    ORDER BY t.created_at DESC
    LIMIT ? OFFSET ?
  `).all(req.user.id, Number(limit), Number(offset));
  res.json(txs.map(t => ({ ...t, amount: t.amount / 100 })));
});

// POST /api/wallet/withdraw — запрос на вывод
router.post('/withdraw', requireAuth, requireVerified, (req, res) => {
  const { amount, method } = req.body;
  if (!amount || amount < 500) return res.status(400).json({ error: 'Минимальная сумма вывода — ₽500' });

  const wallet = db.prepare('SELECT * FROM wallets WHERE user_id = ?').get(req.user.id);
  const amountKopecks = Math.round(amount * 100);

  if (wallet.balance < amountKopecks) return res.status(400).json({ error: 'Недостаточно средств' });

  // В реальной реализации здесь интеграция с платёжной системой
  db.prepare('UPDATE wallets SET balance = balance - ? WHERE user_id = ?').run(amountKopecks, req.user.id);
  db.prepare(`INSERT INTO transactions (uuid, user_id, type, amount, direction, description, status)
    VALUES (?, ?, 'withdrawal', ?, 'out', ?, 'pending')`
  ).run(uuidv4(), req.user.id, amountKopecks, `Вывод на ${method || 'карту'}`);

  db.prepare(`INSERT INTO notifications (user_id, type, title, body)
    VALUES (?, 'payment', ?, ?)`
  ).run(req.user.id, 'Запрос на вывод принят', `Вывод ₽${amount} обрабатывается. Срок: 1–2 рабочих дня.`);

  res.json({ success: true, message: 'Запрос на вывод принят' });
});

module.exports = router;


// routes/notifications.js — в том же файле для простоты
const notifRouter = require('express').Router();

// GET /api/notifications
notifRouter.get('/', requireAuth, (req, res) => {
  const { page = 1, limit = 30 } = req.query;
  const offset = (page - 1) * limit;
  const items = db.prepare(`
    SELECT * FROM notifications WHERE user_id = ?
    ORDER BY created_at DESC LIMIT ? OFFSET ?
  `).all(req.user.id, Number(limit), Number(offset));
  const unread = db.prepare('SELECT COUNT(*) as cnt FROM notifications WHERE user_id = ? AND is_read = 0').get(req.user.id);
  res.json({ notifications: items, unread: unread.cnt });
});

// PATCH /api/notifications/read-all
notifRouter.patch('/read-all', requireAuth, (req, res) => {
  db.prepare('UPDATE notifications SET is_read = 1 WHERE user_id = ?').run(req.user.id);
  res.json({ success: true });
});

// PATCH /api/notifications/:id/read
notifRouter.patch('/:id/read', requireAuth, (req, res) => {
  db.prepare('UPDATE notifications SET is_read = 1 WHERE id = ? AND user_id = ?').run(req.params.id, req.user.id);
  res.json({ success: true });
});

module.exports = { walletRouter: router, notifRouter };
