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
  const ch = alertChannels({ title, fields, footer });
  const [telegram, slack] = await Promise.all([ch.telegram, ch.slack]);
  const outcome = { telegram, slack };
  console.log('[notify]', JSON.stringify(outcome));
  return outcome;
}

/** Reject after ms, so one stalled service can't hold the request open. */
export function withTimeout(promise, ms, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms} ms`)), ms); }),
  ]).finally(() => clearTimeout(timer));
}

/**
 * Start each channel on its own, each with its own timeout. Returns one
 * promise per channel; each resolves to 'sent', 'skipped (...)' or
 * 'failed: ...' and never rejects, so the caller can act on whichever
 * lands first instead of waiting for the slowest.
 */
export function alertChannels({ title, fields, footer }, { timeoutMs = 6000 } = {}) {
  // The fetch itself is aborted at the limit (not just stopped being awaited).
  // A timeout is reported as 'timeout: ...' because the message may still land.
  const outcome = (e) => (e?.name === 'TimeoutError' || e?.name === 'AbortError' || /timed out/.test(e?.message || '')
    ? `timeout: ${e.message}` : `failed: ${e.message}`);
  const signal = () => AbortSignal.timeout(timeoutMs);
  return {
    telegram: withTimeout(sendTelegram({ title, fields, footer }, signal()), timeoutMs + 250, 'telegram')
      .then(() => 'sent', outcome),
    slack: withTimeout(sendSlack({ title, fields, footer }, signal()), timeoutMs + 250, 'slack')
      .then(r => r, outcome),
  };
}

async function sendTelegram({ title, fields, footer }, signal) {
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
    signal,
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

async function sendSlack({ title, fields, footer }, signal) {
  const token = process.env.SLACK_BOT_TOKEN;
  const channel = process.env.SLACK_CHANNEL_ID;
  // Not configured is a valid state, not an error — don't log noise for it.
  if (!token || !channel) return 'skipped (not configured)';

  // Slack mrkdwn: escape & < > so visitor text can't add @channel or links.
  const sl = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const lines = [
    `*${sl(title)}*`,
    '',
    ...Object.entries(fields).map(([k, v]) => `*${sl(k)}:* ${sl(v || '—')}`),
  ];
  if (footer) lines.push('', sl(footer));

  const res = await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    signal,
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
