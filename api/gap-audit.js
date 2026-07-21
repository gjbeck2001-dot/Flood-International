/**
 * Flood Systems — Free Gap Audit (lead magnet)
 *
 * Trigger: the /#audit form on floodinternational.com (same-origin POST).
 * Pipeline: form → Postgres CRM (Railway) → Telegram alert → confirmation email
 *
 * Why this exists: before 2026-07-20 the only conversion action on the site
 * was "Book a call" — a 30-minute commitment from a cold visitor. Everyone
 * not ready for that left no trace. This captures them with a low-commitment
 * ask and gives the content push something to convert into.
 *
 * The audit itself is delivered manually by Nicholas (flood-demo skill +
 * FIOS deliverable templates). Nothing here promises automated delivery.
 *
 * Attribution: utm_* params are captured client-side and folded into the
 * CRM row, so "which post produced this lead" is answerable.
 */

import nodemailer from 'nodemailer';
import { insertLead } from './lib/crm-db.js';
import { notifyLead } from './lib/notify.js';

const MAX = { name: 120, email: 160, company: 160, url: 300, challenge: 1200, utm: 120 };

const clean = (v, max) => String(v ?? '').trim().slice(0, max);
const isEmail = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e);

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const b = req.body || {};

    // Honeypot — real users never fill a hidden field. Return 200 so bots
    // can't distinguish a rejection from a success and retry differently.
    if (clean(b.website_url_confirm, 10)) {
      console.log('[gap-audit] honeypot triggered, silently dropped');
      return res.status(200).json({ ok: true });
    }

    const name      = clean(b.name, MAX.name);
    const email     = clean(b.email, MAX.email).toLowerCase();
    const company   = clean(b.company, MAX.company);
    const link      = clean(b.link, MAX.url);
    const challenge = clean(b.challenge, MAX.challenge);

    if (!name || !email) return res.status(400).json({ error: 'Name and email are required.' });
    if (!isEmail(email)) return res.status(400).json({ error: 'That email address looks wrong.' });

    const utm = {
      source:   clean(b.utm_source, MAX.utm),
      medium:   clean(b.utm_medium, MAX.utm),
      campaign: clean(b.utm_campaign, MAX.utm),
      content:  clean(b.utm_content, MAX.utm),
    };
    const referrer = clean(b.referrer, MAX.url);

    // The CRM schema CHECK-constrains `source` to a fixed set
    // ('Instagram','TikTok',…,'Website') — free-form values are rejected by
    // Postgres. Every gap-audit lead arrives via the site, so 'Website' is
    // the honest value; per-channel attribution lives in notes (utm_* lines).
    const source = 'Website';

    const notes = [
      'FREE GAP AUDIT REQUEST (lead magnet)',
      challenge ? `\nWhat they say is broken:\n${challenge}` : null,
      '\n— Attribution —',
      utm.source   ? `utm_source: ${utm.source}`     : null,
      utm.medium   ? `utm_medium: ${utm.medium}`     : null,
      utm.campaign ? `utm_campaign: ${utm.campaign}` : null,
      utm.content  ? `utm_content: ${utm.content}`   : null,
      referrer     ? `referrer: ${referrer}`         : null,
      `Submitted: ${new Date().toISOString()}`,
      '\nOwed: 1-page gap report. Deliver with the flood-demo skill.',
    ].filter(Boolean).join('\n');

    // The CRM write is the only record of this lead — it alone decides the
    // status code. Notification and email are best-effort.
    await insertLead({
      name,
      email,
      company,
      source,
      notes,
      websiteSocial: link || null,
    });

    await Promise.allSettled([
      notifyLead({
        title: '🔍 New Gap Audit request',
        fields: {
          Name: name,
          Email: email,
          Brand: company,
          Link: link,
          Source: utm.source || (referrer ? 'referral' : 'direct'),
          Campaign: utm.campaign,
          Says: challenge ? challenge.slice(0, 220) : '',
        },
        footer: 'Owes: 1-page gap report. CRM: Flood pipeline (FIELD OS → Pipeline panel).',
      }),
      sendConfirmationEmail({ name, email }),
    ]);

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('[gap-audit] Fatal:', err);
    return res.status(500).json({ error: 'Something broke on our end. Try again in a moment.' });
  }
}

async function sendConfirmationEmail({ name, email }) {
  const user = process.env.GMAIL_USER;
  if (!user || !process.env.GMAIL_APP_PASSWORD) throw new Error('GMAIL creds not set');

  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user, pass: process.env.GMAIL_APP_PASSWORD },
  });

  await transporter.sendMail({
    from: `"Nicholas King — Flood International" <${user}>`,
    to: email,
    subject: 'Your gap audit — what happens next',
    html: `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:560px;color:#111;line-height:1.6;">
  <p>Hi ${escapeHtml(name)},</p>
  <p>Got your request. I'll go through your brand myself and send back a one-page read on the gaps I find — where attention is leaking, what's unowned, and the highest-leverage thing to fix first.</p>
  <p>Expect it within 2 business days. No call required, no pitch attached. If it's useful and you want to go further, that conversation happens after you've seen the work.</p>
  <p>One thing that makes it sharper: if there's a specific thing you're stuck on, reply to this email and tell me. I'll aim the audit at it.</p>
  <p style="margin-top:28px;">— <strong>Nicholas King</strong><br>
  <span style="color:#666;">Founder, Flood International</span><br>
  <a href="https://floodinternational.com" style="color:#111;">floodinternational.com</a></p>
</div>`,
  });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}
