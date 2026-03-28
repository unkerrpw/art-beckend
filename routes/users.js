// routes/users.js — профиль, навыки, портфолио
const router = require('express').Router();
const { body, validationResult } = require('express-validator');
const { requireAuth, requireVerified } = require('../middleware/auth');
const db = require('../db');

// ===== GET /api/users/me =====
router.get('/me', requireAuth, (req, res) => {
  const user = db.prepare(`
    SELECT u.*, w.balance, w.escrow, w.total_earned, w.total_spent
    FROM users u LEFT JOIN wallets w ON w.user_id = u.id
    WHERE u.id = ?
  `).get(req.user.id);

  const skills = db.prepare('SELECT skill, level FROM user_skills WHERE user_id = ?').all(req.user.id);
  const unread = db.prepare('SELECT COUNT(*) as cnt FROM notifications WHERE user_id = ? AND is_read = 0').get(req.user.id);
  const unreadMsgs = db.prepare('SELECT COUNT(*) as cnt FROM messages WHERE receiver_id = ? AND is_read = 0').get(req.user.id);

  delete user.password_hash;
  res.json({ ...user, skills, unread_notifications: unread.cnt, unread_messages: unreadMsgs.cnt });
});

// ===== PATCH /api/users/me =====
router.patch('/me',
  requireAuth,
  [
    body('first_name').optional().trim().notEmpty().isLength({ max: 50 }),
    body('last_name').optional().trim().notEmpty().isLength({ max: 50 }),
    body('bio').optional().isLength({ max: 2000 }),
    body('specialization').optional().isLength({ max: 200 }),
    body('city').optional().isLength({ max: 100 }),
    body('hourly_rate').optional().isInt({ min: 0, max: 999999 }),
  ],
  (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const allowed = ['first_name', 'last_name', 'bio', 'specialization', 'city', 'hourly_rate', 'username'];
    const updates = {};
    for (const key of allowed) {
      if (req.body[key] !== undefined) updates[key] = req.body[key];
    }

    if (Object.keys(updates).length === 0) return res.status(400).json({ error: 'Нет полей для обновления' });

    const sets = Object.keys(updates).map(k => `${k} = ?`).join(', ');
    db.prepare(`UPDATE users SET ${sets}, updated_at = datetime('now') WHERE id = ?`).run(...Object.values(updates), req.user.id);

    res.json({ success: true });
  }
);

// ===== PUT /api/users/me/skills =====
router.put('/me/skills', requireAuth, (req, res) => {
  const { skills } = req.body; // [{ skill: 'React', level: 90 }]
  if (!Array.isArray(skills)) return res.status(400).json({ error: 'skills должен быть массивом' });

  db.prepare('DELETE FROM user_skills WHERE user_id = ?').run(req.user.id);
  const insert = db.prepare('INSERT INTO user_skills (user_id, skill, level) VALUES (?, ?, ?)');
  for (const s of skills.slice(0, 20)) {
    if (s.skill) insert.run(req.user.id, String(s.skill).slice(0, 50), s.level || 50);
  }
  res.json({ success: true });
});

// ===== GET /api/users/:uuid =====
router.get('/:uuid', (req, res) => {
  const user = db.prepare(`
    SELECT id, uuid, first_name, last_name, username, role, avatar_url, cover_url,
           bio, specialization, city, hourly_rate, is_verified, created_at
    FROM users WHERE uuid = ? AND is_active = 1
  `).get(req.params.uuid);

  if (!user) return res.status(404).json({ error: 'Пользователь не найден' });

  const skills = db.prepare('SELECT skill, level FROM user_skills WHERE user_id = ?').all(user.id);
  const portfolio = db.prepare('SELECT * FROM portfolio WHERE user_id = ? ORDER BY created_at DESC').all(user.id);
  const reviews = db.prepare(`
    SELECT r.*, u.first_name, u.last_name, u.avatar_url
    FROM reviews r JOIN users u ON u.id = r.reviewer_id
    WHERE r.reviewee_id = ? ORDER BY r.created_at DESC LIMIT 20
  `).all(user.id);
  const stats = db.prepare(`
    SELECT COUNT(*) as completed, AVG(r.rating) as avg_rating, COUNT(r.id) as review_count
    FROM projects p LEFT JOIN reviews r ON r.project_id = p.id AND r.reviewee_id = ?
    WHERE (p.freelancer_id = ? OR p.client_id = ?) AND p.status = 'completed'
  `).get(user.id, user.id, user.id);

  res.json({ ...user, skills, portfolio, reviews, stats });
});

// ===== PORTFOLIO =====

// GET /api/users/me/portfolio
router.get('/me/portfolio', requireAuth, (req, res) => {
  const items = db.prepare('SELECT * FROM portfolio WHERE user_id = ? ORDER BY created_at DESC').all(req.user.id);
  res.json(items);
});

// POST /api/users/me/portfolio
router.post('/me/portfolio',
  requireAuth, requireVerified,
  [
    body('title').trim().notEmpty().isLength({ max: 200 }),
    body('description').optional().isLength({ max: 2000 }),
    body('category').optional().isLength({ max: 50 }),
    body('image_url').optional().isURL(),
    body('project_url').optional().isURL(),
  ],
  (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const { title, description, category, image_url, project_url } = req.body;
    const result = db.prepare(`
      INSERT INTO portfolio (user_id, title, description, category, image_url, project_url)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(req.user.id, title, description, category, image_url, project_url);

    res.status(201).json({ success: true, id: result.lastInsertRowid });
  }
);

// DELETE /api/users/me/portfolio/:id
router.delete('/me/portfolio/:id', requireAuth, (req, res) => {
  const item = db.prepare('SELECT * FROM portfolio WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!item) return res.status(404).json({ error: 'Элемент не найден' });
  db.prepare('DELETE FROM portfolio WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

// GET /api/users — список фрилансеров
router.get('/', (req, res) => {
  const { page = 1, limit = 20, category, search, role } = req.query;
  const offset = (page - 1) * limit;

  let where = 'WHERE u.is_active = 1 AND u.is_verified = 1';
  const params = [];

  if (role) { where += ' AND u.role = ?'; params.push(role); }
  if (search) { where += ' AND (u.first_name LIKE ? OR u.last_name LIKE ? OR u.specialization LIKE ?)'; const s = `%${search}%`; params.push(s, s, s); }

  const users = db.prepare(`
    SELECT u.id, u.uuid, u.first_name, u.last_name, u.username, u.role,
           u.avatar_url, u.specialization, u.city, u.hourly_rate, u.is_verified,
           AVG(r.rating) as avg_rating, COUNT(DISTINCT r.id) as review_count,
           COUNT(DISTINCT p.id) as completed_projects
    FROM users u
    LEFT JOIN reviews r ON r.reviewee_id = u.id
    LEFT JOIN projects p ON (p.freelancer_id = u.id OR p.client_id = u.id) AND p.status = 'completed'
    ${where}
    GROUP BY u.id
    ORDER BY avg_rating DESC, completed_projects DESC
    LIMIT ? OFFSET ?
  `).all(...params, Number(limit), Number(offset));

  res.json(users);
});

module.exports = router;
