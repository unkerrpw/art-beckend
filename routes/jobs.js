// routes/jobs.js — заказы и отклики
const router = require('express').Router();
const { body, validationResult } = require('express-validator');
const { v4: uuidv4 } = require('uuid');
const { requireAuth, requireVerified } = require('../middleware/auth');
const { sendNewProposalEmail } = require('../email');
const db = require('../db');

// ===== GET /api/jobs — список заказов =====
router.get('/', (req, res) => {
  const { page = 1, limit = 20, category, search, status = 'open', budget_min, budget_max } = req.query;
  const offset = (Number(page) - 1) * Number(limit);

  let where = 'WHERE j.status = ?';
  const params = [status];

  if (category) { where += ' AND j.category = ?'; params.push(category); }
  if (search) { where += ' AND (j.title LIKE ? OR j.description LIKE ?)'; const s = `%${search}%`; params.push(s, s); }
  if (budget_min) { where += ' AND j.budget_max >= ?'; params.push(Number(budget_min)); }
  if (budget_max) { where += ' AND j.budget_min <= ?'; params.push(Number(budget_max)); }

  const total = db.prepare(`SELECT COUNT(*) as cnt FROM jobs j ${where}`).get(...params);
  const jobs = db.prepare(`
    SELECT j.*,
           u.first_name, u.last_name, u.uuid as client_uuid, u.avatar_url,
           COUNT(DISTINCT p.id) as proposals_count
    FROM jobs j
    JOIN users u ON u.id = j.client_id
    LEFT JOIN proposals p ON p.job_id = j.id
    ${where}
    GROUP BY j.id
    ORDER BY j.created_at DESC
    LIMIT ? OFFSET ?
  `).all(...params, Number(limit), Number(offset));

  jobs.forEach(j => j.tags = JSON.parse(j.tags || '[]'));
  res.json({ jobs, total: total.cnt, page: Number(page), limit: Number(limit) });
});

// ===== GET /api/jobs/:uuid =====
router.get('/:uuid', (req, res) => {
  const job = db.prepare(`
    SELECT j.*, u.first_name, u.last_name, u.uuid as client_uuid, u.avatar_url, u.city
    FROM jobs j JOIN users u ON u.id = j.client_id
    WHERE j.uuid = ?
  `).get(req.params.uuid);

  if (!job) return res.status(404).json({ error: 'Заказ не найден' });

  // Увеличиваем счётчик просмотров
  db.prepare('UPDATE jobs SET views = views + 1 WHERE id = ?').run(job.id);

  job.tags = JSON.parse(job.tags || '[]');
  const proposals_count = db.prepare('SELECT COUNT(*) as cnt FROM proposals WHERE job_id = ?').get(job.id);
  res.json({ ...job, proposals_count: proposals_count.cnt });
});

// ===== POST /api/jobs — создать заказ =====
router.post('/',
  requireAuth, requireVerified,
  [
    body('title').trim().notEmpty().isLength({ min: 10, max: 200 }).withMessage('Заголовок 10–200 символов'),
    body('description').trim().notEmpty().isLength({ min: 30, max: 10000 }).withMessage('Описание 30–10000 символов'),
    body('category').notEmpty().withMessage('Укажите категорию'),
    body('budget_min').optional().isInt({ min: 0 }),
    body('budget_max').optional().isInt({ min: 0 }),
    body('tags').optional().isArray({ max: 10 }),
    body('deadline').optional().isISO8601(),
  ],
  (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const { title, description, category, budget_min, budget_max, budget_type, tags = [], deadline } = req.body;
    const jobUuid = uuidv4();

    const result = db.prepare(`
      INSERT INTO jobs (uuid, client_id, title, description, category, budget_min, budget_max, budget_type, tags, deadline)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(jobUuid, req.user.id, title, description, category, budget_min, budget_max, budget_type || 'fixed', JSON.stringify(tags), deadline);

    res.status(201).json({ success: true, id: result.lastInsertRowid, uuid: jobUuid });
  }
);

// ===== PATCH /api/jobs/:uuid =====
router.patch('/:uuid', requireAuth, (req, res) => {
  const job = db.prepare('SELECT * FROM jobs WHERE uuid = ? AND client_id = ?').get(req.params.uuid, req.user.id);
  if (!job) return res.status(404).json({ error: 'Заказ не найден или нет прав' });

  const allowed = ['title', 'description', 'category', 'budget_min', 'budget_max', 'deadline', 'status'];
  const updates = {};
  for (const key of allowed) if (req.body[key] !== undefined) updates[key] = req.body[key];
  if (req.body.tags) updates.tags = JSON.stringify(req.body.tags);

  if (Object.keys(updates).length === 0) return res.status(400).json({ error: 'Нет полей' });
  const sets = Object.keys(updates).map(k => `${k} = ?`).join(', ');
  db.prepare(`UPDATE jobs SET ${sets}, updated_at = datetime('now') WHERE id = ?`).run(...Object.values(updates), job.id);

  res.json({ success: true });
});

// ===== DELETE /api/jobs/:uuid =====
router.delete('/:uuid', requireAuth, (req, res) => {
  const job = db.prepare('SELECT * FROM jobs WHERE uuid = ? AND client_id = ?').get(req.params.uuid, req.user.id);
  if (!job) return res.status(404).json({ error: 'Заказ не найден' });
  if (job.status !== 'open') return res.status(400).json({ error: 'Нельзя удалить активный заказ' });
  db.prepare('DELETE FROM jobs WHERE id = ?').run(job.id);
  res.json({ success: true });
});

// ===== GET /api/jobs/:uuid/proposals =====
router.get('/:uuid/proposals', requireAuth, (req, res) => {
  const job = db.prepare('SELECT * FROM jobs WHERE uuid = ?').get(req.params.uuid);
  if (!job) return res.status(404).json({ error: 'Заказ не найден' });
  if (job.client_id !== req.user.id) return res.status(403).json({ error: 'Нет доступа' });

  const proposals = db.prepare(`
    SELECT p.*, u.first_name, u.last_name, u.uuid as freelancer_uuid, u.avatar_url,
           u.specialization, AVG(r.rating) as avg_rating, COUNT(r.id) as review_count
    FROM proposals p
    JOIN users u ON u.id = p.freelancer_id
    LEFT JOIN reviews r ON r.reviewee_id = u.id
    WHERE p.job_id = ?
    GROUP BY p.id
    ORDER BY p.created_at DESC
  `).all(job.id);

  res.json(proposals);
});

// ===== POST /api/jobs/:uuid/proposals =====
router.post('/:uuid/proposals',
  requireAuth, requireVerified,
  [
    body('cover_letter').trim().notEmpty().isLength({ min: 50, max: 3000 }).withMessage('Сопроводительное письмо 50–3000 символов'),
    body('price').isInt({ min: 100 }).withMessage('Укажите цену'),
    body('delivery_days').isInt({ min: 1, max: 365 }).withMessage('Срок 1–365 дней'),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const job = db.prepare('SELECT * FROM jobs WHERE uuid = ? AND status = ?').get(req.params.uuid, 'open');
    if (!job) return res.status(404).json({ error: 'Заказ не найден или закрыт' });
    if (job.client_id === req.user.id) return res.status(400).json({ error: 'Нельзя откликаться на свои заказы' });

    const existing = db.prepare('SELECT id FROM proposals WHERE job_id = ? AND freelancer_id = ?').get(job.id, req.user.id);
    if (existing) return res.status(409).json({ error: 'Вы уже откликались на этот заказ' });

    const { cover_letter, price, delivery_days } = req.body;
    const result = db.prepare(`
      INSERT INTO proposals (job_id, freelancer_id, cover_letter, price, delivery_days)
      VALUES (?, ?, ?, ?, ?)
    `).run(job.id, req.user.id, cover_letter, price, delivery_days);

    // Уведомление заказчику
    db.prepare(`INSERT INTO notifications (user_id, type, title, body, link)
      VALUES (?, 'proposal', ?, ?, ?)`
    ).run(job.client_id, 'Новый отклик', `Получен отклик на заказ "${job.title}"`, `/jobs/${job.uuid}`);

    // Email заказчику
    const client = db.prepare('SELECT email, first_name FROM users WHERE id = ?').get(job.client_id);
    try { await sendNewProposalEmail(client.email, client.first_name, job.title); } catch {}

    res.status(201).json({ success: true, id: result.lastInsertRowid });
  }
);

// ===== GET /api/jobs/my/posted — мои заказы =====
router.get('/my/posted', requireAuth, (req, res) => {
  const jobs = db.prepare(`
    SELECT j.*, COUNT(DISTINCT p.id) as proposals_count
    FROM jobs j LEFT JOIN proposals p ON p.job_id = j.id
    WHERE j.client_id = ?
    GROUP BY j.id ORDER BY j.created_at DESC
  `).all(req.user.id);
  jobs.forEach(j => j.tags = JSON.parse(j.tags || '[]'));
  res.json(jobs);
});

// ===== GET /api/jobs/my/proposals — мои отклики =====
router.get('/my/proposals', requireAuth, (req, res) => {
  const proposals = db.prepare(`
    SELECT p.*, j.title as job_title, j.uuid as job_uuid, j.budget_min, j.budget_max, j.category,
           u.first_name as client_first, u.last_name as client_last
    FROM proposals p
    JOIN jobs j ON j.id = p.job_id
    JOIN users u ON u.id = j.client_id
    WHERE p.freelancer_id = ? ORDER BY p.created_at DESC
  `).all(req.user.id);
  res.json(proposals);
});

module.exports = router;
