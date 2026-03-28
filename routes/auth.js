// routes/auth.js — регистрация, верификация email, вход, выход
const router = require('express').Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const { body, validationResult } = require('express-validator');
const rateLimit = require('express-rate-limit');
const db = require('../db');
const { sendVerificationEmail, sendWelcomeEmail } = require('../email');

// Лимитеры
const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 10, message: { error: 'Слишком много попыток, подождите 15 минут' } });
const verifyLimiter = rateLimit({ windowMs: 60 * 1000, max: 5, message: { error: 'Подождите перед повторной отправкой кода' } });

function generateCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

function generateTokens(userId) {
  const accessToken = jwt.sign({ userId }, process.env.JWT_SECRET, { expiresIn: '15m' });
  const refreshToken = uuidv4();
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(); // 30 дней
  db.prepare('INSERT INTO sessions (user_id, refresh_token, expires_at) VALUES (?, ?, ?)').run(userId, refreshToken, expiresAt);
  return { accessToken, refreshToken };
}

// ===== POST /api/auth/register =====
router.post('/register',
  authLimiter,
  [
    body('email').isEmail().normalizeEmail().withMessage('Некорректный email'),
    body('password').isLength({ min: 8 }).withMessage('Пароль минимум 8 символов'),
    body('first_name').trim().notEmpty().isLength({ max: 50 }).withMessage('Введите имя'),
    body('last_name').trim().notEmpty().isLength({ max: 50 }).withMessage('Введите фамилию'),
    body('role').optional().isIn(['freelancer', 'client', 'both']),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { email, password, first_name, last_name, role = 'both' } = req.body;

    // Проверяем дубликат
    const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
    if (existing) {
      return res.status(409).json({ error: 'Этот email уже зарегистрирован' });
    }

    const passwordHash = await bcrypt.hash(password, 12);
    const userUuid = uuidv4();

    // Создаём пользователя
    const result = db.prepare(`
      INSERT INTO users (uuid, email, password_hash, first_name, last_name, role)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(userUuid, email, passwordHash, first_name.trim(), last_name.trim(), role);

    const userId = result.lastInsertRowid;

    // Создаём кошелёк
    db.prepare('INSERT INTO wallets (user_id) VALUES (?)').run(userId);

    // Генерируем код верификации
    const code = generateCode();
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString(); // 15 минут
    db.prepare('INSERT INTO email_verifications (user_id, code, expires_at) VALUES (?, ?, ?)').run(userId, code, expiresAt);

    // Отправляем письмо
    try {
      await sendVerificationEmail(email, first_name, code);
    } catch (err) {
      console.error('Ошибка отправки email:', err.message);
      // Не фейлим регистрацию из-за email, но сообщаем
      return res.status(201).json({
        success: true,
        userId,
        message: 'Аккаунт создан, но письмо не отправлено. Используйте повторную отправку.',
        emailError: true,
      });
    }

    res.status(201).json({
      success: true,
      userId,
      message: `Код подтверждения отправлен на ${email}`,
    });
  }
);

// ===== POST /api/auth/verify-email =====
router.post('/verify-email',
  verifyLimiter,
  [
    body('userId').isInt().withMessage('Некорректный userId'),
    body('code').isLength({ min: 6, max: 6 }).isNumeric().withMessage('Код должен быть 6 цифр'),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const { userId, code } = req.body;

    const verification = db.prepare(`
      SELECT * FROM email_verifications
      WHERE user_id = ? AND code = ? AND used = 0 AND expires_at > datetime('now')
      ORDER BY created_at DESC LIMIT 1
    `).get(userId, code);

    if (!verification) {
      return res.status(400).json({ error: 'Неверный или истёкший код' });
    }

    // Помечаем код как использованный
    db.prepare('UPDATE email_verifications SET used = 1 WHERE id = ?').run(verification.id);

    // Верифицируем пользователя
    db.prepare('UPDATE users SET is_verified = 1, updated_at = datetime(\'now\') WHERE id = ?').run(userId);

    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);

    // Уведомление
    db.prepare('INSERT INTO notifications (user_id, type, title, body) VALUES (?, ?, ?, ?)').run(
      userId, 'system', 'Email подтверждён!', 'Твой аккаунт полностью активирован. Добро пожаловать на ArtWin!'
    );

    // Отправляем приветственное письмо
    try { await sendWelcomeEmail(user.email, user.first_name); } catch {}

    // Выдаём токены
    const tokens = generateTokens(userId);

    res.json({
      success: true,
      message: 'Email успешно подтверждён!',
      ...tokens,
      user: {
        id: user.id,
        uuid: user.uuid,
        email: user.email,
        first_name: user.first_name,
        last_name: user.last_name,
        role: user.role,
        is_verified: 1,
      },
    });
  }
);

// ===== POST /api/auth/resend-code =====
router.post('/resend-code',
  verifyLimiter,
  [body('userId').isInt()],
  async (req, res) => {
    const { userId } = req.body;
    const user = db.prepare('SELECT * FROM users WHERE id = ? AND is_verified = 0').get(userId);
    if (!user) return res.status(404).json({ error: 'Пользователь не найден или уже верифицирован' });

    // Инвалидируем старые коды
    db.prepare('UPDATE email_verifications SET used = 1 WHERE user_id = ? AND used = 0').run(userId);

    const code = generateCode();
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();
    db.prepare('INSERT INTO email_verifications (user_id, code, expires_at) VALUES (?, ?, ?)').run(userId, code, expiresAt);

    try {
      await sendVerificationEmail(user.email, user.first_name, code);
      res.json({ success: true, message: 'Новый код отправлен' });
    } catch (err) {
      res.status(500).json({ error: 'Не удалось отправить письмо: ' + err.message });
    }
  }
);

// ===== POST /api/auth/login =====
router.post('/login',
  authLimiter,
  [
    body('email').isEmail().normalizeEmail(),
    body('password').notEmpty(),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const { email, password } = req.body;
    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);

    if (!user) return res.status(401).json({ error: 'Неверный email или пароль' });
    if (!user.is_active) return res.status(403).json({ error: 'Аккаунт заблокирован' });

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return res.status(401).json({ error: 'Неверный email или пароль' });

    const tokens = generateTokens(user.id);
    const wallet = db.prepare('SELECT balance, escrow FROM wallets WHERE user_id = ?').get(user.id);

    res.json({
      success: true,
      ...tokens,
      user: {
        id: user.id,
        uuid: user.uuid,
        email: user.email,
        first_name: user.first_name,
        last_name: user.last_name,
        username: user.username,
        role: user.role,
        avatar_url: user.avatar_url,
        bio: user.bio,
        specialization: user.specialization,
        city: user.city,
        hourly_rate: user.hourly_rate,
        is_verified: user.is_verified,
        wallet: wallet || { balance: 0, escrow: 0 },
      },
    });
  }
);

// ===== POST /api/auth/refresh =====
router.post('/refresh', (req, res) => {
  const { refresh_token } = req.body;
  if (!refresh_token) return res.status(401).json({ error: 'Refresh token не указан' });

  const session = db.prepare(`
    SELECT * FROM sessions WHERE refresh_token = ? AND expires_at > datetime('now')
  `).get(refresh_token);

  if (!session) return res.status(401).json({ error: 'Недействительный или истёкший refresh token' });

  // Удаляем старую сессию (rotation)
  db.prepare('DELETE FROM sessions WHERE id = ?').run(session.id);

  const tokens = generateTokens(session.user_id);
  res.json({ success: true, ...tokens });
});

// ===== POST /api/auth/logout =====
router.post('/logout', (req, res) => {
  const { refresh_token } = req.body;
  if (refresh_token) {
    db.prepare('DELETE FROM sessions WHERE refresh_token = ?').run(refresh_token);
  }
  res.json({ success: true });
});

module.exports = router;
