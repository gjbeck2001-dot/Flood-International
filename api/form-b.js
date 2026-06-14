const NOTION_DB_ID = process.env.NOTION_DATABASE_ID;
const SLACK_CHANNEL = process.env.SLACK_CHANNEL_ID;
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  try {
    const { fields, createdAt } = req.body;
    const name = fields?.['Your full name'] || '';
    const email = fields?.['Email address'] || '';
    const brand = fields?.['Brand / company name'] || 'N/A';
    const tier = fields?.['Which Flood Systems tier are you joining?'] || '';
    const phone = fields?.['Phone number'] || '';
    const website = fields?.['Website or social link'] || '';
    const goal = fields?.['What is your primary goal right now?'] || '';
    const submitted = createdAt || new Date().toISOString();
    if (!name || !email) return res.status(400).json({ error: 'Missing required fields' });
    const results = await Promise.allSettled([
      writeToNotion({ name, email, phone, brand, tier, website, goal, submitted }),
      sendSlackAlert({ name, email, brand, tier, submitted }),
    ]);
    const errors = results.filter(r => r.status === 'rejected').map(r => r.reason?.message || 'Unknown error');
    if (errors.length > 0) console.error('[form-b] Partial failure:', errors);
    return res.status(200).json({ ok: true, errors: errors.length ? errors : undefined });
  } catch (err) {
    console.error('[form-b] Fatal error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
async function writeToNotion({ name, email, phone, brand, tier, website, goal, submitted }) {
  const notes = [website ? `Website: ${website}` : null, goal ? `Goal: ${goal}` : null, 'Source: Form B - Full Intake'].filter(Boolean).join('\n');
  const response = await fetch('https://api.notion.com/v1/pages', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${process.env.NOTION_API_KEY}`, 'Notion-Version': '2022-06-28', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      parent: { database_id: NOTION_DB_ID },
      properties: {
        Name: { title: [{ text: { content: name } }] },
        Email: { email: email },
        Phone: { phone_number: phone || null },
        ...(brand && brand !== 'N/A' ? { Brand: { rich_text: [{ text: { content: brand } }] } } : {}),
        Tier: { rich_text: [{ text: { content: tier } }] },
        Source: { rich_text: [{ text: { content: 'Form B - Full Intake' } }] },
        Notes: { rich_text: [{ text: { content: notes } }] },
        Status: { select: { name: 'Intake Complete' } },
        'Intake Complete': { checkbox: true },
        'Submitted At': { date: { start: submitted } },
      },
    }),
  });
  if (!response.ok) { const body = await response.text(); throw new Error(`Notion write failed: ${response.status} - ${body}`); }
  return response.json();
}
async function sendSlackAlert({ name, email, brand, tier, submitted }) {
  const date = new Date(submitted).toLocaleString('en-US', { month: 'long', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true });
  const text = ['🔥🔥 *Full Intake Submitted - Serious Prospect*', '', `*Name:* ${name}`, `*Email:* ${email}`, `*Brand:* ${brand || 'N/A'}`, `*Tier:* ${tier || 'N/A'}`, `*Submitted:* ${date}`, '', 'They completed all 49 questions. Book the discovery call within 24 hours.', `Full responses -> https://tally.so/forms/ZjQdAV/submissions`].join('\n');
  const response = await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${process.env.SLACK_BOT_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ channel: SLACK_CHANNEL, text, mrkdwn: true }),
  });
  const data = await response.json();
  if (!data.ok) throw new Error(`Slack alert failed: ${data.error}`);
  return data;
}
