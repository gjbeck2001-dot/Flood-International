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
import { alertChannels, withTimeout } from './lib/notify.js';

const MAX = { name: 120, email: 160, company: 160, url: 300, challenge: 1200, utm: 120, phone: 40, industry: 80, sid: 64 };

// One name for the lead magnet, used in the alert, owner email and visitor
// email. The page must use the same string (checked by feas/check_home.py).
// Ruled by Nick 2026-10-29.
const CHECK_NAME = 'Free reply-time check';
// Must match the <select> options on the page (checked by check_home.py).
const INDUSTRIES = ['Aesthetics & med-spas', 'Luxury real estate', 'Exotic & luxury car rental',
  'Wellness, fitness & recovery', 'Custom homes', 'Luxury events', 'Other'];
const LOCATIONS = ['1', '2', '3', '4+'];

const clean = (v, max) => String(v ?? '').trim().slice(0, max);
// One plain address only: no separators that nodemailer would read as a second recipient.
const isEmail = (e) => /^[^\s@,;<>"()]+@[^\s@,;<>"()]+\.[^\s@,;<>"()]{2,}$/.test(e);

// Only our own pages may post (browsers always send Origin on fetch POST).
// Production + this project's Vercel previews + local dev.
const ALLOWED_ORIGIN = /^(https:\/\/(www\.)?floodinternational\.com|https:\/\/flood-international[a-z0-9-]*\.vercel\.app|http:\/\/(localhost|127\.0\.0\.1)(:\d+)?)$/;

// Best-effort limits so the confirmation email can't be used to mail strangers
// in bulk (security review 2026-10-29). In-memory, so they hold per warm
// instance only; a Vercel Firewall rate-limit rule is the durable version.
const hits = new Map();
function overLimit(key, max, windowMs) {
  const now = Date.now();
  const recent = (hits.get(key) || []).filter((t) => now - t < windowMs);
  recent.push(now);
  hits.set(key, recent);
  if (hits.size > 5000) hits.clear();
  return recent.length > max;
}
// Greeting uses the first name, letters only, so a visitor can't put a
// sentence (or a phone number) into an email sent from our account.
// Per-channel time limits (ms). Gmail SMTP measured up to 27.7 s cold.
const ms = (v, d) => (Number(v) > 0 ? Number(v) : d);   // env override is for tests only
const TIMEOUT_MS = {
  alert: ms(process.env.LEAD_ALERT_TIMEOUT_MS, 6000),
  ownerEmail: ms(process.env.LEAD_EMAIL_TIMEOUT_MS, 25000),
  confirmEmail: ms(process.env.LEAD_EMAIL_TIMEOUT_MS, 25000),
};

// Resolves with the name of the first channel that reports 'sent', or null
// once every channel has finished without one.
function firstSent(records) {
  return new Promise((resolve) => {
    const entries = Object.entries(records);
    let left = entries.length;
    for (const [k, p] of entries) {
      p.then((v) => {
        if (v === 'sent') resolve(k);
        if (--left === 0) resolve(null);
      });
    }
  });
}

// Duplicate guard: in-memory, so per warm instance (same limits as overLimit).
const seen = new Map();
function isDuplicate(...keys) {
  const now = Date.now();
  for (const [k, t] of seen) if (now - t > 10 * 60 * 1000) seen.delete(k);
  const live = keys.filter(Boolean);
  if (live.some((k) => seen.has(k))) return true;
  live.forEach((k) => seen.set(k, now));
  return false;
}
function forgetDuplicate(...keys) { keys.filter(Boolean).forEach((k) => seen.delete(k)); }

const firstName = (n) => (String(n).trim().split(/\s+/)[0] || '').replace(/[^\p{L}'-]/gu, '').slice(0, 30);

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    if (!ALLOWED_ORIGIN.test(String(req.headers.origin || ''))) {
      return res.status(403).json({ error: 'Please use the form on floodinternational.com.' });
    }
    const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
    if (overLimit(`ip:${ip}`, 5, 10 * 60 * 1000)) {
      return res.status(429).json({ error: 'Too many requests. Please try again later.' });
    }

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
    // The number clients call (Nick ruled 2026-10-29: required; the two calls need it).
    const phone     = clean(b.phone, MAX.phone);
    const digits    = phone.replace(/\D/g, '');
    const phoneOk   = digits.length === 10 || (digits.length === 11 && digits[0] === '1');
    // Industry and locations are required and must be one of the listed options.
    const industry  = clean(b.industry, MAX.industry);
    const locations = clean(b.locations, 4);
    const submissionId = clean(b.submission_id, 64);

    if (!name || !email) return res.status(400).json({ error: 'Name and email are required.' });
    if (!isEmail(email)) return res.status(400).json({ error: 'That email address looks wrong.' });
    if (!phone) return res.status(400).json({ error: 'Business phone is required.' });
    if (!phoneOk) return res.status(400).json({ error: 'Please enter a 10-digit business phone number.' });
    if (!INDUSTRIES.includes(industry)) return res.status(400).json({ error: 'Please choose your industry.' });
    if (!LOCATIONS.includes(locations)) return res.status(400).json({ error: 'Please choose your number of locations.' });

    // Retries and double clicks: the same form submission, or the same
    // business sent again within 10 minutes, is acknowledged once and not re-sent.
    if (isDuplicate(submissionId ? `sid:${submissionId}` : null, `lead:${email}|${digits}`)) {
      console.log('[gap-audit] duplicate submission acknowledged, not re-sent');
      return res.status(200).json({ ok: true, duplicate: true });
    }
    if (overLimit(`email:${email}`, 2, 24 * 60 * 60 * 1000)) {
      return res.status(429).json({ error: 'We already have a request for this email. Reply to our email if you need anything.' });
    }

    const utm = {
      source:   clean(b.utm_source, MAX.utm),
      medium:   clean(b.utm_medium, MAX.utm),
      campaign: clean(b.utm_campaign, MAX.utm),
      content:  clean(b.utm_content, MAX.utm),
    };
    const referrer = clean(b.referrer, MAX.url);

    const notes = [
      `${CHECK_NAME.toUpperCase()} REQUEST (lead magnet)`,
      `Business phone: ${phone}`,
      `Industry: ${industry || '—'}`,
      `Locations: ${locations || '—'}`,
      challenge ? `\nWhere inquiries come in:\n${challenge}` : null,
      '\n— Attribution —',
      utm.source   ? `utm_source: ${utm.source}`     : null,
      utm.medium   ? `utm_medium: ${utm.medium}`     : null,
      utm.campaign ? `utm_campaign: ${utm.campaign}` : null,
      utm.content  ? `utm_content: ${utm.content}`   : null,
      referrer     ? `referrer: ${referrer}`         : null,
      `Submitted: ${new Date().toISOString()}`,
      '\nOwed: 4 contacts over 7 days (morning call, lunch call, evening form/text, weekend message), then the 1-page reply-time report.',
    ].filter(Boolean).join('\n');

    // Two independent records: Telegram alert + owner email. The Railway CRM
    // died ~09-30 and was dropped here 2026-10-08 (ruling R3); the prospect
    // system of record is the vault company notes. Telegram is fast (<1s);
    // Gmail SMTP can take 20s+ cold (measured 27.7s), so the visitor waits
    // only for Telegram and the emails finish via waitUntil. If Telegram
    // fails we block on the owner email; 500 only if both fail.
    const channels = alertChannels({
      title: `🔍 New ${CHECK_NAME.toLowerCase()} request`,
      fields: {
        Name: name,
        Email: email,
        Business: company,
        Link: link,
        Phone: phone,
        Industry: industry,
        Locations: locations,
        Source: utm.source || (referrer ? 'referral' : 'direct'),
        Campaign: utm.campaign,
        Inquiries: challenge ? challenge.slice(0, 220) : '',
      },
      footer: 'Owes: 4 contacts over 7 days + 1-page reply-time report. Log it in the company note.',
    }, { timeoutMs: TIMEOUT_MS.alert });

    // All three record channels start now, each with its own timeout. The
    // visitor gets success as soon as ANY one confirms the lead was captured;
    // the rest (and the confirmation email) finish in the background.
    const records = {
      telegram: channels.telegram,
      slack: channels.slack,
      ownerCopy: withTimeout(sendOwnerCopy({ name, email, company, link, notes }), TIMEOUT_MS.ownerEmail, 'owner email')
        .then(() => 'sent', (e) => `failed: ${e.message}`),
    };
    const allRecords = Promise.all(Object.entries(records).map(([k, p]) => p.then((v) => [k, v])))
      .then((pairs) => { const r = Object.fromEntries(pairs); console.log('[gap-audit] records', JSON.stringify(r)); return r; });
    const captured = await firstSent(records);

    if (!captured) {
      await allRecords;
      forgetDuplicate(submissionId ? `sid:${submissionId}` : null, `lead:${email}|${digits}`);   // let a retry through
      throw new Error('no record captured (every channel failed or timed out)');
    }
    waitUntil(Promise.all([
      allRecords,
      withTimeout(sendConfirmationEmail({ name, email }), TIMEOUT_MS.confirmEmail, 'confirmation email')
        .catch((e) => console.error('[gap-audit] confirmation email failed:', e.message)),
    ]));
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('[gap-audit] Fatal:', err);
    return res.status(500).json({ error: 'Something broke on our end. Please email king@floodinternational.com and we will reply the same business day.' });
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
    subject: `${CHECK_NAME} request — ${company || name}`,
    text: [
      `Name: ${name}`,
      `Email: ${email}`,
      `Business: ${company || '—'}`,
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
    subject: `Your ${CHECK_NAME.toLowerCase()}: what happens next`,
    html: `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:560px;color:#1A1410;line-height:1.6;">
  <p>Hi${firstName(name) ? ' ' + escapeHtml(firstName(name)) : ''},</p>
  <p>Thanks for requesting a ${escapeHtml(CHECK_NAME.toLowerCase())}. Here is what happens next.</p>
  <p>Our first contact comes within 2 business days. Over the 7 days from then, we will contact your business 4 times: a weekday morning call, a weekday lunch call, an evening website form or text, and a weekend message. We say who we are every time; we never pose as a client. We don't record anything, and we text only a number you list for texting, once. We only count a reply as late against your own listed hours or any reply time you promise.</p>
  <p>Within 2 business days of the last contact we send you one page showing when each reply came, or didn't. No call required and no pitch attached. If it's useful and you want to talk about it, that happens after you've seen it.</p>
  <p>One thing makes it sharper: reply to this email with your business hours and the number or form you most want tested.</p>
  <p style="margin-top:28px;">— <strong>Nicholas King</strong><br>
  <span style="color:#8B7355;">Founder, Flood International · Los Angeles</span><br>
  <a href="https://floodinternational.com" style="color:#1A1410;">floodinternational.com</a></p>
</div>`,
  });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}
