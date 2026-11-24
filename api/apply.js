/**
 * Flood International — "Apply to work with us" questionnaire (/apply)
 *
 * 2026-11-17 (Nick): owners ready to buy a monthly plan fill in their business,
 * what's slipping, the plan and the budget. Same delivery path as the proof
 * shoot form (api/gap-audit.js), deliberately a separate endpoint so that form
 * is untouched: Telegram alert + owner email (either one = captured), then a
 * confirmation email with the Calendly link. Nothing is stored here; Nick saves
 * the lead in the company's prospect note (FIELD OS → Calls).
 * "Budget: not right now" is accepted and flagged; Nick decides on the call.
 */

import nodemailer from 'nodemailer';
import { waitUntil } from '@vercel/functions';
import { alertChannels, withTimeout } from './lib/notify.js';

const CALENDLY = 'https://calendly.com/king-floodinternational/25-minute-sales-call';
const MAX = { best_time: 80, name: 120, email: 160, company: 160, url: 300, challenge: 1200, utm: 120, phone: 40 };

// Every list must match the options in apply.html.
const INDUSTRIES = ['Aesthetics & med-spas', 'Luxury real estate', 'Exotic & luxury car rental',
  'Wellness, fitness & recovery', 'Custom homes', 'Luxury events', 'Other'];
const LOCATIONS = ['1', '2', '3', '4+'];
const YEARS = ['Under 2', '2-5', '5-10', '10+'];
const VALUES = ['Under $1,000', '$1,000-$5,000', '$5,000-$20,000', '$20,000+'];
const SLIPPING = ['After-hours inquiries wait until the next day', 'Consults or estimates never book',
  'Calls missed while with clients', 'Not enough photos and video', "Past clients don't come back", 'Other'];
const PLANS = { 'Booked Jobs': '$2,500/mo', 'Not sure': 'help me choose' };
const BUDGETS = ['Yes', "Depends on what's included", 'Not right now'];
const STARTS = ['This month', 'Next month', 'Just exploring'];

const clean = (v, max) => (typeof v === 'string' || typeof v === 'number' ? String(v) : '').trim().slice(0, max);
const isEmail = (e) => /^[^\s@,;<>"()]+@[^\s@,;<>"()]+\.[^\s@,;<>"()]{2,}$/.test(e);
const oneOf = (v, list) => list.includes(v);

function allowedOrigins() {
  const list = ['https://floodinternational.com', 'https://www.floodinternational.com'];
  for (const h of [process.env.VERCEL_URL, process.env.VERCEL_BRANCH_URL]) if (h) list.push(`https://${h}`);
  return list;
}
const isAllowedOrigin = (o) => allowedOrigins().includes(o)
  || (process.env.VERCEL_ENV !== 'production' && /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(o));

// In-memory limits, per warm instance (same as the proof shoot form).
const hits = new Map();
function overLimit(key, max, windowMs) {
  const now = Date.now();
  const recent = (hits.get(key) || []).filter((t) => now - t < windowMs);
  recent.push(now);
  hits.set(key, recent);
  if (hits.size > 5000) hits.clear();
  return recent.length > max;
}
const ms = (v, d) => (Number(v) > 0 ? Number(v) : d);   // env override is for tests only
const TIMEOUT_MS = {
  alert: ms(process.env.LEAD_ALERT_TIMEOUT_MS, 6000),
  ownerEmail: ms(process.env.LEAD_EMAIL_TIMEOUT_MS, 25000),
  confirmEmail: ms(process.env.LEAD_EMAIL_TIMEOUT_MS, 25000),
};

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

// pending / captured / uncertain / failed, as in api/gap-audit.js.
const LEAD_TTL_MS = 10 * 60 * 1000;
const leads = new Map();
function findLead(keys) {
  const now = Date.now();
  for (const [k, v] of leads) if (now - v.at > LEAD_TTL_MS) leads.delete(k);
  for (const k of keys) if (leads.has(k)) return leads.get(k);
  return null;
}
const capturedByEmail = new Map();
function capturedCount(email) {
  const now = Date.now();
  const recent = (capturedByEmail.get(email) || []).filter((t) => now - t < 24 * 60 * 60 * 1000);
  capturedByEmail.set(email, recent);
  if (capturedByEmail.size > 5000) capturedByEmail.clear();
  return recent.length;
}
const isTimeout = (v) => typeof v === 'string' && v.startsWith('timeout');
const UNCERTAIN_MSG = "We couldn't confirm your application went through. Please don't send the form again. Email king@floodinternational.com with your business name and we'll make sure we have it.";
const FAILED_MSG = 'Something broke on our end. Please email king@floodinternational.com.';

const firstName = (n) => (String(n).trim().split(/\s+/)[0] || '').replace(/[^\p{L}'-]/gu, '').slice(0, 30);

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  let release = null;
  try {
    if (!isAllowedOrigin(String(req.headers.origin || ''))) {
      return res.status(403).json({ error: 'Please use the form on floodinternational.com.' });
    }
    const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
    if (overLimit(`ip:${ip}`, 5, 10 * 60 * 1000)) {
      return res.status(429).json({ error: 'Too many requests. Please try again later.' });
    }

    const b = req.body || {};
    if (clean(b.website_url_confirm, 10)) {
      console.log('[apply] honeypot triggered, silently dropped');
      return res.status(200).json({ ok: true });
    }

    const name      = clean(b.name, MAX.name);
    const email     = clean(b.email, MAX.email).toLowerCase();
    const company   = clean(b.company, MAX.company);
    const link      = clean(b.link, MAX.url);
    const phone     = clean(b.phone, MAX.phone);
    const digits    = phone.replace(/\D/g, '');
    const phoneOk   = digits.length === 10 || (digits.length === 11 && digits[0] === '1');
    const industry  = clean(b.industry, 80);
    const locations = clean(b.locations, 4);
    const years     = clean(b.years, 20);
    const value     = clean(b.client_value, 30);
    const slipping  = (Array.isArray(b.slipping) ? b.slipping : [b.slipping]).map((s) => clean(s, 80)).filter(Boolean);
    const challenge = clean(b.challenge, MAX.challenge);
    const plan      = clean(b.plan, 20);
    const budget    = clean(b.budget, 40);
    const start     = clean(b.start, 20);
    const bestTime  = clean(b.best_time, MAX.best_time);
    const submissionId = clean(b.submission_id, 64);
    const utm = {
      source:   clean(b.utm_source, MAX.utm),
      medium:   clean(b.utm_medium, MAX.utm),
      campaign: clean(b.utm_campaign, MAX.utm),
      content:  clean(b.utm_content, MAX.utm),
    };
    const referrer = clean(b.referrer, MAX.url);

    if (!name || !email) return res.status(400).json({ error: 'Name and email are required.' });
    if (!isEmail(email)) return res.status(400).json({ error: 'That email address looks wrong.' });
    if (!phone) return res.status(400).json({ error: 'Phone is required.' });
    if (!phoneOk) return res.status(400).json({ error: 'Please enter a 10-digit phone number.' });
    if (!company) return res.status(400).json({ error: 'Business name is required.' });
    if (!oneOf(industry, INDUSTRIES)) return res.status(400).json({ error: 'Please choose your industry.' });
    if (!oneOf(locations, LOCATIONS)) return res.status(400).json({ error: 'Please choose your number of locations.' });
    if (!Object.hasOwn(PLANS, plan)) return res.status(400).json({ error: 'Please choose a plan, or "Not sure".' });
    if (!oneOf(budget, BUDGETS)) return res.status(400).json({ error: 'Please answer the budget question.' });
    if (years && !oneOf(years, YEARS)) return res.status(400).json({ error: 'Please choose your years in business.' });
    if (value && !oneOf(value, VALUES)) return res.status(400).json({ error: 'Please choose what a new client is worth.' });
    if (start && !oneOf(start, STARTS)) return res.status(400).json({ error: 'Please choose when you would like to start.' });
    if (slipping.length > SLIPPING.length || slipping.some((s) => !oneOf(s, SLIPPING))) {
      return res.status(400).json({ error: "Please choose from the listed options under What's slipping." });
    }

    const keys = [submissionId ? `sid:${submissionId}` : null, `lead:${email}|${digits}`].filter(Boolean);
    const prior = findLead(keys);
    if (prior) {
      const outcome = prior.state === 'pending' ? await prior.outcome : prior.state;
      console.log('[apply] duplicate submission, original outcome:', outcome);
      return respond(res, outcome, true);
    }
    if (capturedCount(email) >= 2) {
      return res.status(429).json({ error: 'We already have an application for this email. Reply to our email if you need anything.' });
    }
    let settle;
    const entry = { state: 'pending', at: Date.now(), outcome: new Promise((r) => { settle = r; }) };
    keys.forEach((k) => leads.set(k, entry));
    let settled = false;
    let started = false;
    const finish = (outcome) => {
      if (settled) return entry.state === 'pending' ? 'failed' : entry.state;
      settled = true;
      if (outcome === 'failed') keys.forEach((k) => { if (leads.get(k) === entry) leads.delete(k); });
      else entry.state = outcome;
      if (outcome === 'captured') capturedByEmail.set(email, [...(capturedByEmail.get(email) || []), Date.now()]);
      settle(outcome);
      return outcome;
    };
    release = () => finish(started ? 'uncertain' : 'failed');

    const planLine = `${plan} (${PLANS[plan]})`;
    const budgetFlag = budget === 'Not right now' ? 'BUDGET: NOT NOW' : `Budget: ${budget}`;
    const notes = [
      'APPLICATION: work with Flood (monthly plan)',
      budgetFlag,
      `Plan: ${planLine}`,
      `Start: ${start || '—'}`,
      '',
      `Phone: ${phone}`,
      `Industry: ${industry}`,
      `Locations: ${locations}`,
      `Years in business: ${years || '—'}`,
      `One new client is worth (first year): ${value || '—'}`,
      `Best time to call: ${bestTime || '—'}`,
      '',
      `What's slipping: ${slipping.length ? slipping.join('; ') : '—'}`,
      challenge ? `In their words:\n${challenge}` : null,
      '\n— Attribution —',
      utm.source   ? `utm_source: ${utm.source}`     : null,
      utm.medium   ? `utm_medium: ${utm.medium}`     : null,
      utm.campaign ? `utm_campaign: ${utm.campaign}` : null,
      utm.content  ? `utm_content: ${utm.content}`   : null,
      referrer     ? `referrer: ${referrer}`         : null,
      `Submitted: ${new Date().toISOString()}`,
      '\nOwed: a call within 1 business day (they may book Calendly first). Log it in the company note (FIELD OS → Calls).',
    ].filter((l) => l !== null).join('\n');

    const channels = alertChannels({
      title: `📝 New application: ${company} (${plan})`,
      fields: {
        Budget: budget === 'Not right now' ? '⚠️ NOT RIGHT NOW' : budget,
        Plan: planLine,
        Start: start,
        Name: name,
        Email: email,
        Phone: phone,
        Business: company,
        Link: link,
        Industry: industry,
        Locations: locations,
        'Client value': value,
        Slipping: slipping.join('; '),
        'Their words': challenge ? challenge.slice(0, 220) : '',
        'Best time': bestTime,
        Source: utm.source || (referrer ? 'referral' : 'direct'),
      },
      footer: 'Owes: a call within 1 business day. Log it in the company note (FIELD OS → Calls).',
    }, { timeoutMs: TIMEOUT_MS.alert });
    started = true;

    const records = {
      telegram: channels.telegram,
      slack: channels.slack,
      ownerCopy: withTimeout(sendOwnerCopy({ name, email, company, link, plan, notes }), TIMEOUT_MS.ownerEmail, 'owner email')
        .then(() => 'sent', (e) => (isTransportTimeout(e) ? `timeout: ${e.message}` : `failed: ${e.message}`)),
    };
    const allRecords = Promise.all(Object.entries(records).map(([k, p]) => p.then((v) => [k, v])))
      .then((pairs) => { const r = Object.fromEntries(pairs); console.log('[apply] records', JSON.stringify(r)); return r; });
    const captured = await firstSent(records);

    if (!captured) {
      const r = await allRecords;
      const outcome = Object.values(r).some(isTimeout) ? 'uncertain' : 'failed';
      console.error('[apply] no record confirmed:', outcome);
      return respond(res, finish(outcome));
    }
    finish('captured');
    waitUntil(Promise.all([
      allRecords,
      withTimeout(sendConfirmationEmail({ name, email }), TIMEOUT_MS.confirmEmail, 'confirmation email')
        .catch((e) => console.error('[apply] confirmation email failed:', e.message)),
    ]));
    return respond(res, 'captured');
  } catch (err) {
    console.error('[apply] Fatal:', err);
    if (release) return respond(res, release());
    return res.status(500).json({ error: FAILED_MSG });
  }
}

const isTransportTimeout = (e) => /timed? ?out|ETIMEDOUT|ESOCKET|ECONNRESET/i.test(`${e?.code || ''} ${e?.message || ''}`);

function respond(res, outcome, duplicate = false) {
  if (outcome === 'captured') return res.status(200).json({ ok: true, ...(duplicate ? { duplicate: true } : {}) });
  if (outcome === 'uncertain') return res.status(202).json({ ok: false, pending: true, message: UNCERTAIN_MSG });
  return res.status(500).json({ error: FAILED_MSG });
}

function mailer() {
  const user = process.env.GMAIL_USER;
  if (!user || !process.env.GMAIL_APP_PASSWORD) throw new Error('GMAIL creds not set');
  return {
    user,
    transporter: nodemailer.createTransport({
      service: 'gmail',
      auth: { user, pass: process.env.GMAIL_APP_PASSWORD },
      connectionTimeout: Math.min(10000, Math.floor(TIMEOUT_MS.ownerEmail * 0.8)),
      greetingTimeout: Math.min(10000, Math.floor(TIMEOUT_MS.ownerEmail * 0.8)),
      socketTimeout: Math.floor(TIMEOUT_MS.ownerEmail * 0.8),
    }),
  };
}

async function sendOwnerCopy({ name, email, company, link, plan, notes }) {
  const { user, transporter } = mailer();
  await transporter.sendMail({
    from: `"Flood site" <${user}>`,
    to: process.env.LEAD_INBOX || user,
    replyTo: email,
    subject: `New application: ${company.replace(/[\r\n\t]+/g, ' ')} (${plan})`,
    text: [`Name: ${name}`, `Email: ${email}`, `Business: ${company}`, `Link: ${link || '—'}`, '', notes].join('\n'),
  });
}

async function sendConfirmationEmail({ name, email }) {
  const { user, transporter } = mailer();
  await transporter.sendMail({
    from: `"Nicholas King — Flood International" <${user}>`,
    to: email,
    subject: 'Your application to Flood International: what happens next',
    html: `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:560px;color:#1A1410;line-height:1.6;">
  <p>Hi${firstName(name) ? ' ' + escapeHtml(firstName(name)) : ''},</p>
  <p>Thanks for applying to work with Flood International. I'll read your answers before we talk, so the call is about your business.</p>
  <p>Next step: a 25-minute call. <a href="${CALENDLY}" style="color:#1A1410;">Pick a time here</a>, or I'll call you within 1 business day at the number you gave us.</p>
  <p>On the call we'll go through what's slipping, whether the plan fits, and what the first month would look like. The plan is month to month with no setup fee, and nothing starts until you've signed the agreement.</p>
  <p style="margin-top:28px;">— <strong>Nicholas King</strong><br>
  <span style="color:#8B7355;">Founder, Flood International · Los Angeles</span><br>
  <a href="https://floodinternational.com" style="color:#1A1410;">floodinternational.com</a></p>
</div>`,
  });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
