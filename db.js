// db.js — инициализация SQLite базы данных
const Database = require('better-sqlite3');
const path = require('path');
require('dotenv').config();

const DB_PATH = process.env.DB_PATH || './artwin.db';
const db = new Database(path.resolve(DB_PATH));

// Включаем WAL для производительности
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ===== СОЗДАНИЕ ТАБЛИЦ =====
db.exec(`

-- Пользователи
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  uuid          TEXT UNIQUE NOT NULL,
  email         TEXT UNIQUE NOT NULL COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  first_name    TEXT NOT NULL,
  last_name     TEXT NOT NULL,
  username      TEXT UNIQUE,
  role          TEXT DEFAULT 'both' CHECK(role IN ('freelancer','client','both')),
  avatar_url    TEXT,
  cover_url     TEXT,
  bio           TEXT,
  specialization TEXT,
  city          TEXT,
  hourly_rate   INTEGER DEFAULT 0,
  is_verified   INTEGER DEFAULT 0,   -- email подтверждён
  is_active     INTEGER DEFAULT 1,
  created_at    TEXT DEFAULT (datetime('now')),
  updated_at    TEXT DEFAULT (datetime('now'))
);

-- Email-верификация
CREATE TABLE IF NOT EXISTS email_verifications (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code       TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used       INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);

-- Сессии / refresh tokens
CREATE TABLE IF NOT EXISTS sessions (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  refresh_token TEXT UNIQUE NOT NULL,
  expires_at    TEXT NOT NULL,
  created_at    TEXT DEFAULT (datetime('now'))
);

-- Навыки пользователей
CREATE TABLE IF NOT EXISTS user_skills (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  skill   TEXT NOT NULL,
  level   INTEGER DEFAULT 50 CHECK(level BETWEEN 0 AND 100)
);

-- Портфолио
CREATE TABLE IF NOT EXISTS portfolio (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title       TEXT NOT NULL,
  description TEXT,
  category    TEXT,
  image_url   TEXT,
  project_url TEXT,
  created_at  TEXT DEFAULT (datetime('now'))
);

-- Заказы (jobs)
CREATE TABLE IF NOT EXISTS jobs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  uuid        TEXT UNIQUE NOT NULL,
  client_id   INTEGER NOT NULL REFERENCES users(id),
  title       TEXT NOT NULL,
  description TEXT NOT NULL,
  category    TEXT NOT NULL,
  tags        TEXT DEFAULT '[]',        -- JSON array
  budget_min  INTEGER,
  budget_max  INTEGER,
  budget_type TEXT DEFAULT 'fixed' CHECK(budget_type IN ('fixed','hourly')),
  deadline    TEXT,
  status      TEXT DEFAULT 'open' CHECK(status IN ('open','in_progress','completed','cancelled')),
  views       INTEGER DEFAULT 0,
  created_at  TEXT DEFAULT (datetime('now')),
  updated_at  TEXT DEFAULT (datetime('now'))
);

-- Отклики на заказы
CREATE TABLE IF NOT EXISTS proposals (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id       INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  freelancer_id INTEGER NOT NULL REFERENCES users(id),
  cover_letter TEXT NOT NULL,
  price        INTEGER NOT NULL,
  delivery_days INTEGER NOT NULL,
  status       TEXT DEFAULT 'pending' CHECK(status IN ('pending','accepted','rejected')),
  created_at   TEXT DEFAULT (datetime('now')),
  UNIQUE(job_id, freelancer_id)
);

-- Услуги фрилансеров (gigs)
CREATE TABLE IF NOT EXISTS gigs (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  uuid         TEXT UNIQUE NOT NULL,
  freelancer_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title        TEXT NOT NULL,
  description  TEXT NOT NULL,
  category     TEXT NOT NULL,
  tags         TEXT DEFAULT '[]',
  price_from   INTEGER NOT NULL,
  delivery_days INTEGER NOT NULL,
  image_url    TEXT,
  is_active    INTEGER DEFAULT 1,
  views        INTEGER DEFAULT 0,
  orders_count INTEGER DEFAULT 0,
  created_at   TEXT DEFAULT (datetime('now')),
  updated_at   TEXT DEFAULT (datetime('now'))
);

-- Проекты (активные контракты)
CREATE TABLE IF NOT EXISTS projects (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  uuid          TEXT UNIQUE NOT NULL,
  job_id        INTEGER REFERENCES jobs(id),
  gig_id        INTEGER REFERENCES gigs(id),
  client_id     INTEGER NOT NULL REFERENCES users(id),
  freelancer_id INTEGER NOT NULL REFERENCES users(id),
  title         TEXT NOT NULL,
  amount        INTEGER NOT NULL,
  deadline      TEXT,
  status        TEXT DEFAULT 'active' CHECK(status IN ('active','review','completed','disputed','cancelled')),
  progress      INTEGER DEFAULT 0 CHECK(progress BETWEEN 0 AND 100),
  created_at    TEXT DEFAULT (datetime('now')),
  updated_at    TEXT DEFAULT (datetime('now'))
);

-- Кошельки
CREATE TABLE IF NOT EXISTS wallets (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       INTEGER UNIQUE NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  balance       INTEGER DEFAULT 0,      -- в копейках/центах
  escrow        INTEGER DEFAULT 0,      -- заморожено
  total_earned  INTEGER DEFAULT 0,
  total_spent   INTEGER DEFAULT 0,
  updated_at    TEXT DEFAULT (datetime('now'))
);

-- Транзакции
CREATE TABLE IF NOT EXISTS transactions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  uuid        TEXT UNIQUE NOT NULL,
  user_id     INTEGER NOT NULL REFERENCES users(id),
  type        TEXT NOT NULL CHECK(type IN ('deposit','withdrawal','escrow_lock','escrow_release','payment','refund','fee')),
  amount      INTEGER NOT NULL,          -- в копейках, положительное число
  direction   TEXT NOT NULL CHECK(direction IN ('in','out')),
  description TEXT,
  project_id  INTEGER REFERENCES projects(id),
  status      TEXT DEFAULT 'completed' CHECK(status IN ('pending','completed','failed')),
  created_at  TEXT DEFAULT (datetime('now'))
);

-- Сообщения
CREATE TABLE IF NOT EXISTS messages (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  sender_id   INTEGER NOT NULL REFERENCES users(id),
  receiver_id INTEGER NOT NULL REFERENCES users(id),
  project_id  INTEGER REFERENCES projects(id),
  content     TEXT NOT NULL,
  is_read     INTEGER DEFAULT 0,
  created_at  TEXT DEFAULT (datetime('now'))
);

-- Отзывы
CREATE TABLE IF NOT EXISTS reviews (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id    INTEGER NOT NULL REFERENCES projects(id),
  reviewer_id   INTEGER NOT NULL REFERENCES users(id),
  reviewee_id   INTEGER NOT NULL REFERENCES users(id),
  rating        INTEGER NOT NULL CHECK(rating BETWEEN 1 AND 5),
  comment       TEXT,
  created_at    TEXT DEFAULT (datetime('now')),
  UNIQUE(project_id, reviewer_id)
);

-- Уведомления
CREATE TABLE IF NOT EXISTS notifications (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type       TEXT NOT NULL,
  title      TEXT NOT NULL,
  body       TEXT,
  link       TEXT,
  is_read    INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);

-- Индексы
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE INDEX IF NOT EXISTS idx_jobs_client ON jobs(client_id);
CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
CREATE INDEX IF NOT EXISTS idx_jobs_category ON jobs(category);
CREATE INDEX IF NOT EXISTS idx_proposals_job ON proposals(job_id);
CREATE INDEX IF NOT EXISTS idx_gigs_freelancer ON gigs(freelancer_id);
CREATE INDEX IF NOT EXISTS idx_projects_client ON projects(client_id);
CREATE INDEX IF NOT EXISTS idx_projects_freelancer ON projects(freelancer_id);
CREATE INDEX IF NOT EXISTS idx_messages_sender ON messages(sender_id);
CREATE INDEX IF NOT EXISTS idx_messages_receiver ON messages(receiver_id);
CREATE INDEX IF NOT EXISTS idx_notifs_user ON notifications(user_id);
CREATE INDEX IF NOT EXISTS idx_transactions_user ON transactions(user_id);

-- Крипто-платежи (CryptoBot)
CREATE TABLE IF NOT EXISTS pending_payments (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  uuid        TEXT UNIQUE NOT NULL,
  user_id     INTEGER NOT NULL REFERENCES users(id),
  invoice_id  INTEGER UNIQUE NOT NULL,
  asset       TEXT NOT NULL,
  asset_amount TEXT NOT NULL,
  usd_amount  REAL NOT NULL,
  status      TEXT DEFAULT 'pending' CHECK(status IN ('pending','paid','expired')),
  created_at  TEXT DEFAULT (datetime('now'))
);

-- Заявки на вывод
CREATE TABLE IF NOT EXISTS withdraw_requests (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  uuid         TEXT UNIQUE NOT NULL,
  user_id      INTEGER NOT NULL REFERENCES users(id),
  asset        TEXT NOT NULL,
  network      TEXT,
  address      TEXT NOT NULL,
  amount_usd   REAL NOT NULL,
  status       TEXT DEFAULT 'pending' CHECK(status IN ('pending','completed','rejected')),
  processed_at TEXT,
  created_at   TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_pending_payments_user ON pending_payments(user_id);
CREATE INDEX IF NOT EXISTS idx_pending_payments_invoice ON pending_payments(invoice_id);
CREATE INDEX IF NOT EXISTS idx_withdraw_requests_user ON withdraw_requests(user_id);
CREATE INDEX IF NOT EXISTS idx_withdraw_requests_status ON withdraw_requests(status);
`);

console.log('✅ База данных инициализирована:', DB_PATH);

module.exports = db;
