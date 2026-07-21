/**
 * Lead notification — Telegram primary, Slack optional.
 *
 * Why Telegram: the Slack bot token was verified DEAD (invalid_auth) on
 * 2026-07-15 and Slack re-auth is still an open item. Until that's fixed,
 * a Slack-only alert path means leads land in the CRM and nobody is told.
 * The FIELD OS Telegram bot is live and already reaches Nicholas's phone.
 *
 * Both paths are FAIL-SOFT by design: a notification failure must never
 * fail the request, because the CRM write is the record that matters and
 * Tally retries on any non-2xx. Callers should keep these out of the
 * "did this succeed" decision.
 *
 * Env:
 *   TELEGRAM_BOT_TOKEN        — from BotFather (same bot as field-os)
 *   TELEGRAM_ALLOWED_CHAT_ID  — Nicholas's chat id
 *   SLACK_BOT_TOKEN           — optional; skipped entirely if unset
 *   SLACK_CHANNEL_ID          — optional
 */

/** Telegram MarkdownV2 is strict — escape everything reserved. */
function esc(s) {
  return String(s ?? '').replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, '\\$&');
}

/**
 * Send a lead alert. Never throws.
 * @returns {Promise<{telegram: string, slack: string}>} per-channel outcome
 */
export async function notifyLead({ title, fields, footer }) {
  const [telegram, slack] = await Promise.all([
    sendTelegram({ title, fields, footer }).then(() => 'sent').catch(e => `failed: ${e.message}`),
    sendSlack({ title, fields, footer }).then(r => r).catch(e => `failed: ${e.message}`),
  ]);
  const outcome = { telegram, slack };
  console.log('[notify]', JSON.stringify(outcome));
  return outcome;
}

async function sendTelegram({ title, fields, footer }) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_ALLOWED_CHAT_ID;
  if (!token || !chatId) throw new Error('TELEGRAM_BOT_TOKEN/CHAT_ID not set');

  const lines = [
    `*${esc(title)}*`,
    '',
    ...Object.entries(fields).map(([k, v]) => `*${esc(k)}:* ${esc(v || '—')}`),
  ];
  if (footer) lines.push('', `_${esc(footer)}_`);

  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text: lines.join('\n'),
      parse_mode: 'MarkdownV2',
      disable_web_page_preview: true,
    }),
  });

  const data = await res.json();
  if (!data.ok) throw new Error(`telegram: ${data.description || res.status}`);
  return data;
}

async function sendSlack({ title, fields, footer }) {
  const token = process.env.SLACK_BOT_TOKEN;
  const channel = process.env.SLACK_CHANNEL_ID;
  // Not configured is a valid state, not an error — don't log noise for it.
  if (!token || !channel) return 'skipped (not configured)';

  const lines = [
    `*${title}*`,
    '',
    ...Object.entries(fields).map(([k, v]) => `*${k}:* ${v || '—'}`),
  ];
  if (footer) lines.push('', footer);

  const res = await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ channel, text: lines.join('\n'), mrkdwn: true }),
  });

  const data = await res.json();
  if (!data.ok) throw new Error(`slack: ${data.error}`);
  return 'sent';
}
