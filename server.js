// server.js — главный файл сервера ArtWin
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const path = require('path');
const rateLimit = require('express-rate-limit');
const fs = require('fs');

// Инициализируем БД
require('./db');

const app = express();
const PORT = process.env.PORT || 3000;

// ===== MIDDLEWARE =====
app.use(helmet({
  contentSecurityPolicy: false, // отключаем для HTML файлов
}));
app.use(cors({
  origin: process.env.SITE_URL || '*',
  credentials: true,
}));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Общий лимитер запросов
app.use('/api/', rateLimit({
  windowMs: 1 * 60 * 1000, // 1 минута
  max: 100,
  standardHeaders: true,
  message: { error: 'Слишком много запросов' },
}));

// Папка для загрузок
const uploadsDir = process.env.UPLOADS_DIR || './uploads';
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
app.use('/uploads', express.static(uploadsDir));

// ===== API ROUTES =====
app.use('/api/auth', require('./routes/auth'));
app.use('/api/users', require('./routes/users'));
app.use('/api/jobs', require('./routes/jobs'));
app.use('/api/messages', require('./routes/messages'));

const { walletRouter, notifRouter } = require('./routes/wallet');
app.use('/api/wallet', walletRouter);
app.use('/api/notifications', notifRouter);

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

// ===== FRONTEND =====
// Раздаём статику из папки frontend/public
const frontendPath = path.join(__dirname, '../frontend/public');
if (fs.existsSync(frontendPath)) {
  app.use(express.static(frontendPath));
  // SPA fallback — все неизвестные маршруты отдают index.html
  app.get('*', (req, res) => {
    res.sendFile(path.join(frontendPath, 'index.html'));
  });
}

// ===== ERROR HANDLER =====
app.use((err, req, res, next) => {
  console.error('Server error:', err);
  res.status(500).json({ error: 'Внутренняя ошибка сервера' });
});

app.listen(PORT, () => {
  console.log(`\n🚀 ArtWin сервер запущен на порту ${PORT}`);
  console.log(`📡 API: http://localhost:${PORT}/api`);
  console.log(`🌐 Сайт: http://localhost:${PORT}\n`);
});
