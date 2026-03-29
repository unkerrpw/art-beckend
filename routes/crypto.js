// routes/crypto.js — интеграция с CryptoBot (@CryptoBot в Telegram)
const router = require('express').Router();
const { v4: uuidv4 } = require('uuid');
const { requireAuth, requireVerified } = require('../middleware/auth');
const db = require('../db');

const CB_API = 'https://pay.crypt.bot/api';
const CB_TOKEN = process.env.CRYPTOBOT_TOKEN;

// Поддерживаемые монеты
const SUPPORTED_ASSETS = ['USDT', 'TON', 'LTC', 'BNB', 'BTC', 'TRX', 'USDC', 'ETH'];

// Хелпер — запрос к CryptoBot API
async function cbRequest(method, params = {}) {
  const url = `${CB_API}/${method}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Crypto-Pay-API-Token': CB_TOKEN,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(params),
  });
  const data = await res.json();
  if (!data.ok) throw new Error(data.error?.name || 'CryptoBot API error');
  return data.result;
}

// ===== GET /api/crypto/assets — список монет =====
router.get('/assets', (req, res) => {
  res.json(SUPPORTED_ASSETS.map(a => ({
    asset: a,
    name: { USDT:'Tether', TON:'Toncoin', LTC:'Litecoin', BNB:'BNB', BTC:'Bitcoin', TRX:'TRON', USDC:'USD Coin', ETH:'Ethereum' }[a] || a,
    emoji: { USDT:'💵', TON:'💎', LTC:'🪙', BNB:'🟡', BTC:'₿', TRX:'🔴', USDC:'🔵', ETH:'⟠' }[a] || '🪙',
  })));
});

// ===== POST /api/crypto/create-invoice — создать инвойс =====
router.post('/create-invoice', requireAuth, requireVerified, async (req, res) => {
  const { asset, amount_usd } = req.body;

  if (!SUPPORTED_ASSETS.includes(asset)) {
    return res.status(400).json({ error: 'Монета не поддерживается' });
  }
  if (!amount_usd || amount_usd < 1) {
    return res.status(400).json({ error: 'Минимальная сумма $1' });
  }
  if (amount_usd > 10000) {
    return res.status(400).json({ error: 'Максимальная сумма $10,000' });
  }

  try {
    // Получаем курс из CryptoBot
    const exchangeData = await cbRequest('getExchangeRates');
    const rate = exchangeData.find(r => r.source === asset && r.target === 'USD');
    let assetAmount;

    if (asset === 'USDT' || asset === 'USDC') {
      assetAmount = amount_usd.toFixed(2);
    } else if (rate) {
      assetAmount = (amount_usd / parseFloat(rate.rate)).toFixed(8);
    } else {
      // Фолбэк — создаём инвойс напрямую в USD
      assetAmount = amount_usd.toFixed(2);
    }

    // Создаём инвойс в CryptoBot
    const invoice = await cbRequest('createInvoice', {
      asset,
      amount: assetAmount,
      description: `Пополнение баланса ArtWin — $${amount_usd}`,
      payload: JSON.stringify({
        user_id: req.user.id,
        amount_usd: parseFloat(amount_usd),
      }),
      allow_comments: false,
      allow_anonymous: false,
      expires_in: 3600, // 1 час
    });

    // Сохраняем ожидающий платёж в БД
    db.prepare(`
      INSERT INTO pending_payments (uuid, user_id, invoice_id, asset, asset_amount, usd_amount, status)
      VALUES (?, ?, ?, ?, ?, ?, 'pending')
    `).run(uuidv4(), req.user.id, invoice.invoice_id, asset, assetAmount, amount_usd);

    res.json({
      invoice_id: invoice.invoice_id,
      pay_url: invoice.pay_url,
      bot_invoice_url: invoice.bot_invoice_url,
      asset,
      amount: assetAmount,
      amount_usd,
      expires_at: invoice.expiration_date,
    });
  } catch (e) {
    console.error('CryptoBot error:', e.message);
    res.status(500).json({ error: 'Ошибка создания платежа: ' + e.message });
  }
});

// ===== POST /api/crypto/check-invoice — проверить статус =====
router.post('/check-invoice', requireAuth, async (req, res) => {
  const { invoice_id } = req.body;
  if (!invoice_id) return res.status(400).json({ error: 'invoice_id required' });

  // Проверяем что инвойс принадлежит пользователю
  const pending = db.prepare('SELECT * FROM pending_payments WHERE invoice_id = ? AND user_id = ?').get(invoice_id, req.user.id);
  if (!pending) return res.status(404).json({ error: 'Платёж не найден' });
  if (pending.status === 'paid') return res.json({ status: 'paid', already_credited: true });

  try {
    const invoices = await cbRequest('getInvoices', { invoice_ids: String(invoice_id) });
    const invoice = invoices.items?.[0];

    if (!invoice) return res.status(404).json({ error: 'Инвойс не найден в CryptoBot' });

    if (invoice.status === 'paid') {
      // Начисляем баланс (в центах)
      const amountCents = Math.round(pending.usd_amount * 100);

      db.prepare('UPDATE wallets SET balance = balance + ?, total_earned = total_earned + ? WHERE user_id = ?')
        .run(amountCents, amountCents, req.user.id);

      db.prepare(`INSERT INTO transactions (uuid, user_id, type, amount, direction, description, status)
        VALUES (?, ?, 'deposit', ?, 'in', ?, 'completed')`)
        .run(uuidv4(), req.user.id, amountCents, `Пополнение ${pending.asset} — $${pending.usd_amount}`);

      db.prepare('UPDATE pending_payments SET status = ? WHERE invoice_id = ?').run('paid', invoice_id);

      db.prepare(`INSERT INTO notifications (user_id, type, title, body)
        VALUES (?, 'payment', ?, ?)`)
        .run(req.user.id, 'Баланс пополнен!', `+$${pending.usd_amount} (${pending.asset}) зачислено на ваш счёт`);

      return res.json({ status: 'paid', amount_usd: pending.usd_amount, asset: pending.asset });
    }

    if (invoice.status === 'expired') {
      db.prepare('UPDATE pending_payments SET status = ? WHERE invoice_id = ?').run('expired', invoice_id);
      return res.json({ status: 'expired' });
    }

    res.json({ status: invoice.status });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ===== POST /api/crypto/webhook — вебхук от CryptoBot (автоматическое зачисление) =====
router.post('/webhook', async (req, res) => {
  // Верификация подписи CryptoBot
  const crypto = require('crypto');
  const secret = crypto.createHash('sha256').update(CB_TOKEN).digest();
  const checkString = JSON.stringify(req.body);
  const hmac = crypto.createHmac('sha256', secret).update(checkString).digest('hex');
  const signature = req.headers['crypto-pay-api-signature'];

  if (hmac !== signature) {
    console.error('CryptoBot webhook: invalid signature');
    return res.status(401).json({ error: 'Invalid signature' });
  }

  const { update_type, payload: update } = req.body;

  if (update_type === 'invoice_paid') {
    const invoice = update;
    try {
      const payloadData = JSON.parse(invoice.payload || '{}');
      const userId = payloadData.user_id;
      const amountUsd = payloadData.amount_usd;
      if (!userId || !amountUsd) return res.json({ ok: true });

      // Проверяем что ещё не зачислено
      const pending = db.prepare('SELECT * FROM pending_payments WHERE invoice_id = ? AND status = ?').get(invoice.invoice_id, 'pending');
      if (!pending) return res.json({ ok: true }); // уже обработано

      const amountCents = Math.round(amountUsd * 100);
      db.prepare('UPDATE wallets SET balance = balance + ?, total_earned = total_earned + ? WHERE user_id = ?').run(amountCents, amountCents, userId);
      db.prepare(`INSERT INTO transactions (uuid, user_id, type, amount, direction, description, status) VALUES (?, ?, 'deposit', ?, 'in', ?, 'completed')`).run(uuidv4(), userId, amountCents, `Пополнение ${invoice.asset} — $${amountUsd}`);
      db.prepare('UPDATE pending_payments SET status = ? WHERE invoice_id = ?').run('paid', invoice.invoice_id);
      db.prepare(`INSERT INTO notifications (user_id, type, title, body) VALUES (?, 'payment', ?, ?)`).run(userId, 'Баланс пополнен!', `+$${amountUsd} зачислено автоматически`);

      console.log(`✅ Webhook: зачислено $${amountUsd} пользователю ${userId}`);
    } catch (e) {
      console.error('Webhook processing error:', e.message);
    }
  }

  res.json({ ok: true });
});

// ===== GET /api/crypto/withdraw-requests — запросы на вывод (для пользователя) =====
router.get('/withdraw-requests', requireAuth, (req, res) => {
  const requests = db.prepare(`
    SELECT * FROM withdraw_requests WHERE user_id = ? ORDER BY created_at DESC LIMIT 20
  `).all(req.user.id);
  res.json(requests);
});

// ===== POST /api/crypto/withdraw — создать заявку на вывод =====
router.post('/withdraw', requireAuth, requireVerified, async (req, res) => {
  const { asset, network, address, amount_usd } = req.body;

  if (!SUPPORTED_ASSETS.includes(asset)) return res.status(400).json({ error: 'Монета не поддерживается' });
  if (!address || address.length < 10) return res.status(400).json({ error: 'Некорректный адрес' });
  if (!amount_usd || amount_usd < 5) return res.status(400).json({ error: 'Минимум $5' });

  const wallet = db.prepare('SELECT * FROM wallets WHERE user_id = ?').get(req.user.id);
  const amountCents = Math.round(amount_usd * 100);

  if (wallet.balance < amountCents) return res.status(400).json({ error: 'Недостаточно средств' });

  // Замораживаем средства
  db.prepare('UPDATE wallets SET balance = balance - ?, escrow = escrow + ? WHERE user_id = ?').run(amountCents, amountCents, req.user.id);

  // Создаём заявку
  const reqUuid = uuidv4();
  db.prepare(`INSERT INTO withdraw_requests (uuid, user_id, asset, network, address, amount_usd, status)
    VALUES (?, ?, ?, ?, ?, ?, 'pending')`).run(reqUuid, req.user.id, asset, network || '', address, amount_usd);

  db.prepare(`INSERT INTO notifications (user_id, type, title, body) VALUES (?, 'payment', ?, ?)`).run(
    req.user.id, 'Заявка на вывод принята', `Вывод $${amount_usd} ${asset} на рассмотрении. Обработка до 24 часов.`
  );

  res.json({ success: true, uuid: reqUuid });
});

module.exports = router;
