/**
 * FAQ search box — a question the box couldn't answer, sent on the visitor's click.
 *
 * Trigger: the "Send this question" button under a no-answer result on the
 * homepage FAQ (assets/faq-ask.js). Sends the question text, exactly as typed,
 * to Telegram only (ruled 2026-10-29). No name, email or IP is attached, and the
 * question is never logged next to the IP. Nothing is promised back to the
 * visitor: no contact details are collected, so no reply is possible.
 *
 * Abuse limits (karpathy de-risk 2026-10-29: a naive per-IP limit let 200
 * rotating IPs send 200 messages): per IP, a global hourly cap, and a 24-hour
 * duplicate check. All in-memory, so per warm instance only. Durable: a Vercel
 * Firewall rule on /api/faq-question (dashboard step, same as the lead form).
 */

import { alertChannels } from './lib/notify.js';

const MIN = 3, MAX = 300;
const LIMIT = { ipMax: 3, ipWindowMs: 10 * 60 * 1000, globalMax: 20, globalWindowMs: 60 * 60 * 1000, dupWindowMs: 24 * 60 * 60 * 1000 };
const TIMEOUT_MS = Number(process.env.FAQ_ALERT_TIMEOUT_MS) > 0 ? Number(process.env.FAQ_ALERT_TIMEOUT_MS) : 6000;   // env is for tests only

// Same exact-origin rule as api/gap-audit.js (keep the two identical).
function allowedOrigins() {
  const list = ['https://floodinternational.com', 'https://www.floodinternational.com'];
  for (const h of [process.env.VERCEL_URL, process.env.VERCEL_BRANCH_URL]) if (h) list.push(`https://${h}`);
  return list;
}
const isAllowedOrigin = (o) => allowedOrigins().includes(o)
  || (process.env.VERCEL_ENV !== 'production' && /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(o));

const hits = new Map();
function overLimit(key, max, windowMs) {
  const now = Date.now();
  const recent = (hits.get(key) || []).filter((t) => now - t < windowMs);
  recent.push(now);
  hits.set(key, recent);
  if (hits.size > 5000) hits.clear();
  return recent.length > max;
}
const seen = new Map();   // normalized question -> time sent

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  try {
    if (!isAllowedOrigin(String(req.headers.origin || ''))) return res.status(403).json({ error: 'Forbidden' });
    const b = req.body && typeof req.body === 'object' ? req.body : {};
    // Honeypot filled = a bot. Answer like a success and send nothing.
    if (typeof b.website_url_confirm === 'string' && b.website_url_confirm.trim()) return res.status(200).json({ ok: true });
    // Strings only: an object, array or number never reaches String() (the 10-29 lead-form crash).
    if (typeof b.q !== 'string') return res.status(400).json({ error: 'Bad request' });
    const q = b.q.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
    if (q.length < MIN || q.length > MAX) return res.status(400).json({ error: 'Bad request' });
    if (/https?:|www\.|[a-z0-9-]+\.(?:com|net|org|io|co|ru|xyz|info|biz|top)\b/i.test(q)) return res.status(400).json({ error: 'Bad request' });

    const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
    if (overLimit(`ip:${ip}`, LIMIT.ipMax, LIMIT.ipWindowMs)) return res.status(429).json({ error: 'Too many requests' });
    // Letters and digits in any script count (review 2026-10-29: an ASCII-only key turned two different
    // Chinese questions into the same empty key, and the second was dropped as a "duplicate").
    const key = q.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim() || q;
    const prev = seen.get(key);
    if (prev) {
      // Sent within 24 h, or being sent right now: never send twice. A concurrent duplicate waits
      // for the original's outcome (review 2026-10-29: two simultaneous requests sent two messages).
      if (prev.pending) return (await prev.pending) ? res.status(200).json({ ok: true, duplicate: true }) : res.status(502).json({ error: 'Not sent' });
      if (Date.now() - prev.at < LIMIT.dupWindowMs) return res.status(200).json({ ok: true, duplicate: true });
    }
    if (overLimit('global', LIMIT.globalMax, LIMIT.globalWindowMs)) return res.status(429).json({ error: 'Too many requests' });

    // Reserve before sending; resolve or release on the outcome, including a crash.
    let settle;
    seen.set(key, { pending: new Promise((r) => { settle = r; }) });
    let sent = false;
    try {
      const telegram = await alertChannels({
        title: 'FAQ question with no answer',
        fields: { Question: q },
        footer: 'Sent from the homepage FAQ search box. No name, email or IP attached.',
      }, { timeoutMs: TIMEOUT_MS, slack: false }).telegram;
      console.log('[faq-question] telegram', telegram);   // the outcome only, never the question
      sent = telegram === 'sent';
    } finally {
      if (sent) seen.set(key, { at: Date.now() }); else seen.delete(key);
      settle(sent);
      if (seen.size > 5000) for (const [k, v] of seen) if (!v.pending) seen.delete(k);
    }
    if (!sent) return res.status(502).json({ error: 'Not sent' });
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('[faq-question] Fatal:', err?.message);
    return res.status(500).json({ error: 'Not sent' });
  }
}
