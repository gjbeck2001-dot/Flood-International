/**
 * Flood Systems — Abandonment Detection Cron
 * Schedule: Every 12 hours (configured in vercel.json)
 * Logic: Find Form B partial submissions → check if they completed intake →
 *        if not, fire Slack alert + send follow-up email
 *
 * "Partial submission" detection method:
 * Tally doesn't natively emit abandonment webhooks on free/pro plans.
 * Instead, this cron queries all Form B submissions in the last 12 hours,
 * then checks our Notion CRM for a matching complete record. If none exists,
 * the person started but didn't finish — we follow up.
 *
 * NOTE: Requires Tally API access token (not just webhook secret).
 * Get it from: tally.so → Settings → API
 */

import nodemailer from 'nodemailer';

const NOTION_DB_ID  = process.env.NOTION_DATABASE_ID;
const SLACK_CHANNEL = process.env.SLACK_CHANNEL_ID;
const TALLY_FORM_B  = 'ZjQdAV';

export default async function handler(req, res) {
  // Vercel cron jobs hit GET — validate the request is from Vercel
  const authHeader = req.headers.authorization;
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    // 1. Fetch Form B submissions from the last 12 hours
    const since = new Date(Date.now() - 12 * 60 * 60 * 1000).toISOString();
    const submissions = await getTallySubmissions(since);

    if (!submissions.length) {
      return res.status(200).json({ ok: true, checked: 0, abandoned: 0 });
    }

    // 2. For each submission, check if they have a complete Notion record
    let abandoned = 0;
    for (const sub of submissions) {
      const email = sub.fields?.['Email address'] || sub.fields?.email_address || '';
      const name  = sub.fields?.['Your full name'] || sub.fields?.full_name    || '';

      if (!email) continue;

      const hasCompleteRecord = await checkNotionForComplete(email);
      if (!hasCompleteRecord) {
        abandoned++;
        await Promise.allSettled([
          sendAbandonmentSlackAlert({ name, email, submitted: sub.createdAt }),
          sendAbandonmentEmail({ name, email }),
        ]);
      }
    }

    return res.status(200).json({ ok: true, checked: submissions.length, abandoned });

  } catch (err) {
    console.error('[abandonment-cron] Fatal error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

async function getTallySubmissions(since) {
  const url = `https://api.tally.so/forms/${TALLY_FORM_B}/submissions?page=1&limit=50`;

  const response = await fetch(url, {
    headers: {
      'Authorization': `Bearer ${process.env.TALLY_API_TOKEN}`,
    },
  });

  if (!response.ok) {
    throw new Error(`Tally API failed: ${response.status}`);
  }

  const data = await response.json();
  const submissions = data?.data?.submissions || [];

  return submissions.filter(s => new Date(s.createdAt) >= new Date(since));
}

async function checkNotionForComplete(email) {
  const response = await fetch(`https://api.notion.com/v1/databases/${NOTION_DB_ID}/query`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.NOTION_API_KEY}`,
      'Notion-Version': '2022-06-28',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      filter: {
        and: [
          {
            property: 'Email',
            email: { equals: email },
          },
          {
            property: 'Notes',
            rich_text: { contains: 'Full 49-question intake completed' },
          },
        ],
      },
      page_size: 1,
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Notion query failed: ${response.status} — ${body}`);
  }

  const data = await response.json();
  return data.results.length > 0;
}

async function sendAbandonmentSlackAlert({ name, email, submitted }) {
  const date = submitted
    ? new Date(submitted).toLocaleString('en-US', {
        month: 'long', day: 'numeric', year: 'numeric',
        hour: 'numeric', minute: '2-digit', hour12: true,
      })
    : 'Unknown';

  const text = [
    '⚠️ *Abandoned Intake Detected*',
    '',
    `*Name:* ${name || 'Unknown'}`,
    `*Email:* ${email}`,
    `*Started:* ${date}`,
    '',
    'They filled out contact info but did not complete the full intake.',
    'Follow up within the hour — warm lead going cold.',
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
  if (!data.ok) throw new Error(`Slack failed: ${data.error}`);
}

async function sendAbandonmentEmail({ name, email }) {
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
    subject: 'Still thinking about it? — Flood Systems',
    html: `
      <div style="font-family: -apple-system, sans-serif; max-width: 560px; color: #111;">
        <p>Hi${name ? ` ${name}` : ''},</p>
        <br>
        <p>You started your Flood Systems intake but didn't finish. That's fine — it's a big decision.</p>
        <br>
        <p>If you want to pick up where you left off:</p>
        <p><a href="https://tally.so/r/ZjQdAV" style="color: #111;">Complete your intake →</a></p>
        <br>
        <p>Or if you'd rather just talk through it first, reply here and we'll set something up directly.</p>
        <br>
        <p>— <strong>Nicholas King</strong><br>
        Flood Systems — Flood International</p>
      </div>
    `,
  });
}
