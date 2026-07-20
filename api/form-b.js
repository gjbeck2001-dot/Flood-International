/**
 * Flood Systems — Form B Webhook Handler
 * Trigger: Tally Form B (ID: ZjQdAV) — Full 49-question client intake
 * Pipeline: Tally → Postgres CRM (Railway) → Slack High-Signal Alert
 *
 * Phase 6 cutover (2026-07-19): Notion write path removed — the Railway
 * Postgres CRM is the sole source of truth. A failed CRM write fails the
 * request (Tally retries on non-2xx) because there is no second copy anymore.
 *
 * NOTE: Form B uses full question label text as field keys (bracket notation).
 * This is a Tally quirk for multi-section forms. Do NOT use snake_case slugs.
 * Reference: [C] Make.com Scenario Build Guide.md — Field Key Troubleshooting
 */

import { insertLead } from './lib/crm-db.js';

const SLACK_CHANNEL = process.env.SLACK_CHANNEL_ID;

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { fields, createdAt } = req.body;

    // Form B uses full label text as keys — exact match required
    const name    = fields?.['Your full name']                              || '';
    const email   = fields?.['Email address']                               || '';
    const brand   = fields?.['Brand / company name']                        || 'N/A';
    const tier    = fields?.['Which Flood Systems tier are you joining?']   || '';
    const phone   = fields?.['Phone number']                                || '';
    const website = fields?.['Website or social link']                      || '';
    const goal    = fields?.['What is your primary goal right now?']        || '';
    const submitted = createdAt || new Date().toISOString();

    if (!name || !email) {
      return res.status(400).json({ error: 'Missing required fields: name, email' });
    }

    const results = await Promise.allSettled([
      writeToPostgres({ name, email, phone, brand, tier, website, goal, submitted }),
      sendSlackAlert({ name, email, brand, tier, submitted }),
    ]);

    const errors = results
      .filter(r => r.status === 'rejected')
      .map(r => r.reason?.message || 'Unknown error');

    if (errors.length > 0) {
      console.error('[form-b] Partial failure:', errors);
    }

    // The CRM write is the only record of the lead — if it failed, fail the
    // request so Tally retries instead of the lead landing nowhere.
    if (results[0].status === 'rejected') {
      return res.status(500).json({ error: 'CRM write failed', errors });
    }

    return res.status(200).json({ ok: true, errors: errors.length ? errors : undefined });

  } catch (err) {
    console.error('[form-b] Fatal error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

// ─── Postgres CRM ─────────────────────────────────────────────────────────────

async function writeToPostgres({ name, email, phone, brand, tier, website, goal, submitted }) {
  const notes = [
    tier ? `Tier interest: ${tier}` : null,
    goal ? `Goal: ${goal}` : null,
    `Submitted via Tally (Form B — Full Intake): ${submitted}`,
    'Full 49-question intake completed',
  ].filter(Boolean).join('\n');

  await insertLead({ name, email, phone, company: brand, notes, websiteSocial: website });
}

async function sendSlackAlert({ name, email, brand, tier, submitted }) {
  const date = new Date(submitted).toLocaleString('en-US', {
    month: 'long', day: 'numeric', year: 'numeric',
    hour: 'numeric', minute: '2-digit', hour12: true,
  });

  const text = [
    '🔥🔥 *Full Intake Submitted — Serious Prospect*',
    '',
    `*Name:* ${name}`,
    `*Email:* ${email}`,
    `*Brand:* ${brand || 'N/A'}`,
    `*Tier:* ${tier || 'N/A'}`,
    `*Submitted:* ${date}`,
    '',
    '⚡ They completed all 49 questions. Book the discovery call within 24 hours.',
    '',
    `Full responses → <https://tally.so/forms/ZjQdAV/submissions|Tally Submissions>`,
    'CRM: logged to the Flood pipeline (FIELD OS → Pipeline panel)',
  ].join('\n');

  const response = await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.SLACK_BOT_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ channel: SLACK_CHANNEL, text, mrkdwn: true }),
  });

  const data = await response.json();
  if (!data.ok) throw new Error(`Slack alert failed: ${data.error}`);
  return data;
}
