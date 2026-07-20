/**
 * Flood Systems — Form A Webhook Handler
 * Trigger: Tally Form A (ID: A7QpVB) — Quick Intake popup on floodinternational.com
 * Pipeline: Tally → Postgres CRM (Railway) → Slack Alert → Prospect Email
 *
 * Phase 6 cutover (2026-07-19): Notion write path removed — burn-in ran with
 * zero drift, the Railway Postgres CRM is the sole source of truth. A failed
 * CRM write now fails the request (Tally retries on non-2xx) because there is
 * no second copy anymore.
 */

import nodemailer from 'nodemailer';
import { insertLead } from './lib/crm-db.js';

const SLACK_CHANNEL = process.env.SLACK_CHANNEL_ID;

export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
        const { fields, submittedAt } = req.body;

      // Field keys from Tally Form A (snake_case — Form A uses slugs, not full labels)
      const name    = fields?.full_name                                   || '';
        const email   = fields?.email_address                               || '';
        const phone   = fields?.phone_number                                || '';
        const brand   = fields?.brand_company_name                          || 'N/A';
        const tier    = fields?.which_tier_are_you_interested_in            || '';
        const submitted = submittedAt || new Date().toISOString();

      if (!name || !email) {
              return res.status(400).json({ error: 'Missing required fields: name, email' });
      }

      // Run in parallel — if one fails, others still complete.
      const results = await Promise.allSettled([
              writeToPostgres({ name, email, phone, brand, tier, submitted }),
              sendSlackAlert({ name, email, brand, tier, submitted }),
              sendConfirmationEmail({ name, email }),
            ]);

      const errors = results
          .filter(r => r.status === 'rejected')
          .map(r => r.reason?.message || 'Unknown error');

      if (errors.length > 0) {
              console.error('[form-a] Partial failure:', errors);
      }

      // The CRM write is the only record of the lead — if it failed, fail the
      // request so Tally retries instead of the lead landing nowhere.
      if (results[0].status === 'rejected') {
              return res.status(500).json({ error: 'CRM write failed', errors });
      }

      return res.status(200).json({ ok: true, errors: errors.length ? errors : undefined });

  } catch (err) {
        console.error('[form-a] Fatal error:', err);
        return res.status(500).json({ error: 'Internal server error' });
  }
}

// ─── Postgres CRM ─────────────────────────────────────────────────────────────

async function writeToPostgres({ name, email, phone, brand, tier, submitted }) {
  const notes = [
    tier ? `Tier interest: ${tier}` : null,
    `Submitted via Tally (Form A — Quick Intake): ${submitted}`,
  ].filter(Boolean).join('\n');

  await insertLead({ name, email, phone, company: brand, notes });
}

// ─── Slack ────────────────────────────────────────────────────────────────────

async function sendSlackAlert({ name, email, brand, tier, submitted }) {
    const date = new Date(submitted).toLocaleString('en-US', {
          month: 'long', day: 'numeric', year: 'numeric',
          hour: 'numeric', minute: '2-digit', hour12: true,
    });

  const text = [
        '🔥 *New Form A Submission*',
        '',
        `*Name:* ${name}`,
        `*Email:* ${email}`,
        `*Brand:* ${brand || 'N/A'}`,
        `*Tier Interest:* ${tier || 'N/A'}`,
        `*Submitted:* ${date}`,
        '',
        'CRM: logged to the Flood pipeline (FIELD OS → Pipeline panel)',
      ].join('\n');

  const response = await fetch('https://slack.com/api/chat.postMessage', {
        method: 'POST',
        headers: {
                'Authorization': `Bearer ${process.env.SLACK_BOT_TOKEN}`,
                'Content-Type': 'application/json',
        },
        body: JSON.stringify({
                channel: SLACK_CHANNEL,
                text,
                mrkdwn: true,
        }),
  });

  const data = await response.json();
    if (!data.ok) throw new Error(`Slack alert failed: ${data.error}`);
    return data;
}

// ─── Email ────────────────────────────────────────────────────────────────────

async function sendConfirmationEmail({ name, email }) {
    const transporter = nodemailer.createTransport({
          service: 'gmail',
          auth: {
                  user: process.env.GMAIL_USER,
                  pass: process.env.GMAIL_APP_PASSWORD,
          },
    });

  await transporter.sendMail({
        from: `"Nicholas King — Flood Systems" <${process.env.GMAIL_USER}>`,
        to: email,
        subject: "You're in — Flood Systems next steps",
        html: `
              <div style="font-family: -apple-system, sans-serif; max-width: 560px; color: #111;">
                      <p>Hi ${name},</p>
                              <br>
                                      <p>Your interest in Flood Systems has been received.</p>
                                              <br>
                                                      <p>We'll be in touch within 24 hours to set up your discovery call. On that call we'll assess your brand, walk through the system, and confirm the right tier for where you are.</p>
                                                              <br>
                                                                      <p>In the meantime — take a look at what we build:</p>
                                                                              <p><a href="https://floodinternational.com" style="color: #111;">floodinternational.com</a></p>
                                                                                      <br>
                                                                                              <p>Talk soon,<br>
                                                                                                      <strong>Nicholas King</strong><br>
                                                                                                              Flood Systems — Flood International</p>
                                                                                                                    </div>
                                                                                                                        `,
  });
}
