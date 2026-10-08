/**
 * Flood Systems — Free Gap Audit (lead magnet)
 *
 * Trigger: the /#audit form on floodinternational.com (same-origin POST).
 * Pipeline: form → Telegram alert + owner email (either one = captured)
 *           → confirmation email to the visitor. No CRM (dropped 2026-10-08).
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
 * alert + owner email, so "which post produced this lead" is answerable.
 */

import nodemailer from 'nodemailer';
import { waitUntil } from '@vercel/functions';
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
      '\nOwed: 1-page missed-job read within 2 business days.',
    ].filter(Boolean).join('\n');

    // Two independent records: Telegram alert + owner email. The Railway CRM
    // died ~09-30 and was dropped here 2026-10-08 (ruling R3); the prospect
    // system of record is the vault company notes. Telegram is fast (<1s);
    // Gmail SMTP can take 20s+ cold (measured 27.7s), so the visitor waits
    // only for Telegram and the emails finish via waitUntil. If Telegram
    // fails we block on the owner email; 500 only if both fail.
    const alert = await notifyLead({
      title: '🔍 New missed-job check request',
      fields: {
        Name: name,
        Email: email,
        Shop: company,
        Link: link,
        Source: utm.source || (referrer ? 'referral' : 'direct'),
        Campaign: utm.campaign,
        Says: challenge ? challenge.slice(0, 220) : '',
      },
      footer: 'Owes: 1-page missed-job read. Log it in the shop\'s company note.',
    });
    const alertOk = alert.telegram === 'sent' || alert.slack === 'sent';

    const ownerCopy = sendOwnerCopy({ name, email, company, link, notes })
      .then(() => 'sent', (e) => `failed: ${e.message}`);
    const confirm = () => sendConfirmationEmail({ name, email })
      .catch((e) => console.error('[gap-audit] confirmation email failed:', e.message));

    if (alertOk) {
      waitUntil(Promise.all([
        ownerCopy.then((o) => console.log('[gap-audit] records', JSON.stringify({ telegram: alert.telegram, ownerCopy: o }))),
        confirm(),
      ]));
      return res.status(200).json({ ok: true });
    }

    const owner = await ownerCopy;
    console.log('[gap-audit] records', JSON.stringify({ telegram: alert.telegram, ownerCopy: owner }));
    if (owner !== 'sent') {
      // Nothing durable landed — tell the visitor so they use the fallback
      // email shown in the form's error state.
      throw new Error('no record captured (alert and owner email both failed)');
    }
    waitUntil(confirm());
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('[gap-audit] Fatal:', err);
    return res.status(500).json({ error: 'Something broke on our end. Try again in a moment.' });
  }
}

function mailer() {
  const user = process.env.GMAIL_USER;
  if (!user || !process.env.GMAIL_APP_PASSWORD) throw new Error('GMAIL creds not set');
  return {
    user,
    transporter: nodemailer.createTransport({
      service: 'gmail',
      auth: { user, pass: process.env.GMAIL_APP_PASSWORD },
    }),
  };
}

/** Full lead to Nicholas's inbox — the durable record alongside the Telegram alert. */
async function sendOwnerCopy({ name, email, company, link, notes }) {
  const { user, transporter } = mailer();
  await transporter.sendMail({
    from: `"Flood site" <${user}>`,
    to: process.env.LEAD_INBOX || user,
    replyTo: email,
    subject: `Missed-job check request — ${company || name}`,
    text: [
      `Name: ${name}`,
      `Email: ${email}`,
      `Shop: ${company || '—'}`,
      `Link: ${link || '—'}`,
      '',
      notes,
    ].join('\n'),
  });
}

async function sendConfirmationEmail({ name, email }) {
  const { user, transporter } = mailer();

  await transporter.sendMail({
    from: `"Nicholas King — Flood International" <${user}>`,
    to: email,
    subject: 'Your missed-job check — what happens next',
    html: `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:560px;color:#111;line-height:1.6;">
  <p>Hi ${escapeHtml(name)},</p>
  <p>Got your request. I'll look at your shop the way a customer does: calling after hours, finding you on Google, reading your reviews, trying to book, and timing how fast anyone gets back to them. You'll get a one-page read on where jobs are slipping and the one thing to fix first.</p>
  <p>Expect it within 2 business days. No call required, no pitch attached. If it's useful and you want to go further, that conversation happens after you've seen the work.</p>
  <p>One thing that makes it sharper: if there's a specific spot where you know jobs get lost, reply to this email and tell me. I'll aim the check at it.</p>
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
