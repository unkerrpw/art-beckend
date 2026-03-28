// email.js — отправка писем через Resend (resend.com)
const { Resend } = require('resend');
require('dotenv').config();

const resend = new Resend(process.env.RESEND_API_KEY);
const FROM = process.env.EMAIL_FROM || 'ArtWin <noreply@artwin.live>';
const SITE = process.env.SITE_URL || 'https://artwin.live';

async function send(to, subject, html) {
  const { error } = await resend.emails.send({ from: FROM, to, subject, html });
  if (error) throw new Error('Email error: ' + error.message);
}

async function sendVerificationEmail(to, name, code) {
  await send(to, `${code} — код подтверждения ArtWin`, `<!DOCTYPE html>
  <html><head><meta charset="UTF-8"></head>
  <body style="margin:0;padding:0;background:#0a0a0f;font-family:'Segoe UI',sans-serif;">
    <div style="max-width:500px;margin:40px auto;background:#12121a;border:1px solid #2a2a3d;border-radius:20px;overflow:hidden;">
      <div style="background:linear-gradient(135deg,#7c5cfc,#fc5cf5);padding:32px;text-align:center;">
        <h1 style="color:#fff;margin:0;font-size:28px;font-weight:800;">ArtWin</h1>
      </div>
      <div style="padding:40px 32px;">
        <h2 style="color:#f0f0ff;font-size:22px;margin:0 0 12px;">Привет, ${name}!</h2>
        <p style="color:#8888aa;font-size:15px;line-height:1.7;margin:0 0 32px;">Для завершения регистрации введи код:</p>
        <div style="background:#1a1a26;border:2px dashed #2a2a3d;border-radius:16px;padding:28px;text-align:center;margin-bottom:32px;">
          <div style="font-size:48px;font-weight:800;letter-spacing:14px;color:#5cfcb4;font-family:monospace;">${code}</div>
          <div style="color:#8888aa;font-size:13px;margin-top:12px;">Код действителен 15 минут</div>
        </div>
        <p style="color:#8888aa;font-size:13px;">Если ты не регистрировался — проигнорируй письмо.</p>
      </div>
      <div style="padding:20px 32px;border-top:1px solid #2a2a3d;text-align:center;">
        <p style="color:#555577;font-size:12px;margin:0;">© 2025 ArtWin · <a href="${SITE}" style="color:#7c5cfc;text-decoration:none;">artwin.live</a></p>
      </div>
    </div>
  </body></html>`);
}

async function sendWelcomeEmail(to, name) {
  await send(to, 'Добро пожаловать на ArtWin! 🚀', `<!DOCTYPE html>
  <html><head><meta charset="UTF-8"></head>
  <body style="margin:0;padding:0;background:#0a0a0f;font-family:'Segoe UI',sans-serif;">
    <div style="max-width:500px;margin:40px auto;background:#12121a;border:1px solid #2a2a3d;border-radius:20px;overflow:hidden;">
      <div style="background:linear-gradient(135deg,#7c5cfc,#fc5cf5);padding:32px;text-align:center;">
        <h1 style="color:#fff;margin:0;font-size:28px;font-weight:800;">ArtWin</h1>
      </div>
      <div style="padding:40px 32px;">
        <h2 style="color:#f0f0ff;font-size:22px;margin:0 0 16px;">Добро пожаловать, ${name}! 🎉</h2>
        <p style="color:#8888aa;font-size:15px;line-height:1.7;margin:0 0 28px;">Аккаунт создан. Размещай заказы и находи клиентов.</p>
        <a href="${SITE}" style="display:inline-block;background:linear-gradient(135deg,#7c5cfc,#fc5cf5);color:#fff;text-decoration:none;padding:14px 32px;border-radius:12px;font-weight:600;font-size:15px;">Начать работу →</a>
      </div>
    </div>
  </body></html>`);
}

async function sendNewMessageEmail(to, fromName, preview) {
  await send(to, `Новое сообщение от ${fromName} — ArtWin`, `
  <div style="font-family:sans-serif;max-width:500px;margin:40px auto;background:#12121a;border:1px solid #2a2a3d;border-radius:16px;padding:32px;color:#f0f0ff;">
    <h2 style="color:#7c5cfc;margin-top:0">Новое сообщение</h2>
    <p style="color:#8888aa"><b style="color:#f0f0ff">${fromName}</b> написал(а):</p>
    <blockquote style="border-left:3px solid #7c5cfc;margin:16px 0;padding:12px 16px;color:#aaaacc;background:#1a1a26;border-radius:0 8px 8px 0">${preview}</blockquote>
    <a href="${SITE}" style="background:#7c5cfc;color:#fff;padding:10px 24px;border-radius:10px;text-decoration:none;font-size:14px;display:inline-block">Ответить</a>
  </div>`);
}

async function sendNewProposalEmail(to, clientName, jobTitle) {
  await send(to, `Новый отклик на "${jobTitle}" — ArtWin`, `
  <div style="font-family:sans-serif;max-width:500px;margin:40px auto;background:#12121a;border:1px solid #2a2a3d;border-radius:16px;padding:32px;color:#f0f0ff;">
    <h2 style="color:#7c5cfc;margin-top:0">Новый отклик!</h2>
    <p style="color:#8888aa">Фрилансер откликнулся на <b style="color:#f0f0ff">"${jobTitle}"</b></p>
    <a href="${SITE}" style="background:#7c5cfc;color:#fff;padding:10px 24px;border-radius:10px;text-decoration:none;font-size:14px;display:inline-block">Посмотреть</a>
  </div>`);
}

module.exports = { sendVerificationEmail, sendWelcomeEmail, sendNewMessageEmail, sendNewProposalEmail };
