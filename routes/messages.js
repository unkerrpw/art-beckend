// routes/messages.js
const router = require('express').Router();
const { body, validationResult } = require('express-validator');
const { requireAuth } = require('../middleware/auth');
const { sendNewMessageEmail } = require('../email');
const db = require('../db');

// GET /api/messages/conversations
router.get('/conversations', requireAuth, (req, res) => {
  const convs = db.prepare(`
    SELECT
      CASE WHEN m.sender_id = ? THEN m.receiver_id ELSE m.sender_id END as partner_id,
      u.first_name, u.last_name, u.uuid, u.avatar_url, u.specialization,
      m.content as last_message, m.created_at, m.is_read,
      SUM(CASE WHEN m.receiver_id = ? AND m.is_read = 0 THEN 1 ELSE 0 END) as unread_count
    FROM messages m
    JOIN users u ON u.id = CASE WHEN m.sender_id = ? THEN m.receiver_id ELSE m.sender_id END
    WHERE m.sender_id = ? OR m.receiver_id = ?
    GROUP BY partner_id
    ORDER BY m.created_at DESC
  `).all(req.user.id, req.user.id, req.user.id, req.user.id, req.user.id);
  res.json(convs);
});

// GET /api/messages/:uuid — история с пользователем
router.get('/:uuid', requireAuth, (req, res) => {
  const partner = db.prepare('SELECT id FROM users WHERE uuid = ?').get(req.params.uuid);
  if (!partner) return res.status(404).json({ error: 'Пользователь не найден' });

  // Помечаем как прочитанные
  db.prepare('UPDATE messages SET is_read = 1 WHERE sender_id = ? AND receiver_id = ?').run(partner.id, req.user.id);

  const msgs = db.prepare(`
    SELECT m.*, u.first_name, u.last_name, u.avatar_url
    FROM messages m JOIN users u ON u.id = m.sender_id
    WHERE (m.sender_id = ? AND m.receiver_id = ?) OR (m.sender_id = ? AND m.receiver_id = ?)
    ORDER BY m.created_at ASC LIMIT 100
  `).all(req.user.id, partner.id, partner.id, req.user.id);

  res.json(msgs);
});

// POST /api/messages/:uuid
router.post('/:uuid',
  requireAuth,
  [body('content').trim().notEmpty().isLength({ max: 5000 })],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const partner = db.prepare('SELECT * FROM users WHERE uuid = ?').get(req.params.uuid);
    if (!partner) return res.status(404).json({ error: 'Пользователь не найден' });
    if (partner.id === req.user.id) return res.status(400).json({ error: 'Нельзя писать себе' });

    const result = db.prepare('INSERT INTO messages (sender_id, receiver_id, content) VALUES (?, ?, ?)').run(req.user.id, partner.id, req.body.content);

    db.prepare(`INSERT INTO notifications (user_id, type, title, body, link)
      VALUES (?, 'message', ?, ?, ?)`
    ).run(partner.id, `Новое сообщение от ${req.user.first_name}`, req.body.content.slice(0, 100), `/messages/${req.user.id}`);

    const unreadCount = db.prepare('SELECT COUNT(*) as cnt FROM messages WHERE receiver_id = ? AND is_read = 0').get(partner.id);
    // Email только если > 3 непрочитанных (не спамим)
    if (unreadCount.cnt <= 3) {
      try { await sendNewMessageEmail(partner.email, req.user.first_name, req.body.content.slice(0, 100)); } catch {}
    }

    res.status(201).json({ success: true, id: result.lastInsertRowid });
  }
);

module.exports = router;
