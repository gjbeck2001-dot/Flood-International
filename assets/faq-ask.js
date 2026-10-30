/**
 * FAQ search box: matches a typed question to one of the FAQ <details> on the
 * homepage. Free, in the browser, no model. Built 2026-10-29 from the karpathy
 * de-risk prototype (scratch v3: DEV 89% top-1, 0 wrong, 0 off-scope answered).
 *
 * Design rule: the box never states an answer. It lists the closest FAQ
 * questions as links and the visitor picks one, so a near miss can't read as a
 * yes to something we don't do. A single-answer version (2026-10-29) scored 33%
 * on two blind sets and answered questions it shouldn't; see faq_eval.mjs.
 *
 * The answers are never stored here: they are read from the page's own
 * <details>, so the box can't drift from what the page says. This file holds
 * only routing words. All visitor-facing text lives in <template>s in
 * index.html (checked by check_home.py); this file must not add any.
 *
 * The pure part (createAsk) is imported by flood-site-checks/faq_eval.mjs, so
 * the eval runs exactly the code the browser runs.
 */

const STOP = new Set(('a an the i im i\'m me my we our us you your u ur is are am was be do does did can could will would should ' +
  'there it its this that these those to of for on in at with and or if so any some just really actually about please pls ' +
  'how what whats what\'s who when which why get have has need want like tell also than then them they he she ' +
  // ordinary conversational filler (general English, not picked from any test question; review 2026-10-29)
  'per by from into over under up down off out as because while until again once here only own same too very all both each ' +
  'every few most such were been being had having yall ya ive id gonna wanna kinda sorta thru though still even already right ' +
  'hey hi hello thanks thank yeah yes yep sure maybe something stuff lot lots bit guys guy folks anyone ' +
  'ill youll youre theyre thats theres whos').split(' '));
const NEG = new Set(['no', 'not', 'dont', 'don\'t', 'never', 'without', 'isnt', 'arent', 'doesnt', 'cant', 'wont', 'nor']);
// Joined before words are split, so a two-word idea counts as one concept.
const PHRASES = [[/\bset ?up\b/g, 'setup'], [/\blong[- ]term\b/g, 'longterm'], [/\block(ed)? in\b/g, 'lockin'], [/\bmoney back\b/g, 'refund'],
  [/\bsocial media\b/g, 'socialmedia'], [/\bmed[- ]?spas?\b/g, 'medspa'], [/\breal estate\b/g, 'realestate'], [/\breply[- ]time\b/g, 'replytime'],
  [/\bmonth to month\b/g, 'monthtomonth'], [/\bcredit card\b/g, 'card'], [/\bcold call(ing)?\b/g, 'coldcall'], [/\bfront desk\b/g, 'frontdesk'],
  [/\bsign up\b/g, 'signup'], [/\bget started\b/g, 'start'], [/\bnot included\b/g, 'notincluded'],
  [/\b(?:don'?t|do not|not) (?:you )?(?:do|offer|cover|include)\b/g, 'notincluded'], [/\bfollow[- ]ups?\b/g, 'followup'],
  [/\bhow much (?:work|effort)\b/g, 'effort'], [/\$\s?3,?000\b/g, ' price '],
  // Leaving said as a phrasal verb: every word is filler on its own ("get out of it"). Not "opt out",
  // which is texting consent, not cancelling.
  [/\b(?:get(?:ting)? out of|back(?:ing)? out|pull(?:ing)? out|walk(?:ing)? away|bail(?:ing)?|pull(?:ing)? the plug|end (?:it|this|things|the service))\b/g, 'cancel'],
  // Competitors are described more often than named: the page's word is "competitor".
  [/\b(?:compet\w*|rivals?|spy(?:ing)? on|poach\w*|keep(?:ing)? (?:tabs|an eye) on|steal(?:s|ing)? (?:my |our )?(?:clients|customers|patients|business))\b/g, 'competitor'],
  // Approval said as a condition on sending. "unless/without + see" is approval; "before/until we see"
  // is usually results ("how long before we see results"), so those take only approval verbs.
  // "'?ve": owners drop apostrophes ("ive", "weve").
  [/\b(?:(?:unless|without) (?:i|me|we|us)(?: have|'?ve)? (?:see|seen|seeing|saw|check(?:ed|ing)?|look(?:ed|ing)? at|review(?:ed|ing)?|ok(?:'?ed|'?ing|'?d)?|okay(?:ed|ing)?|approv(?:e|ed|ing)|sign(?:ed|ing)? off)|(?:until|till|before) (?:i|me|we|us)(?: have|'?ve)? (?:ok(?:'?ed|'?d)?|okay(?:ed)?|approv(?:e|ed)|sign(?:ed)? off)|sign(?:ed|ing)? off on|run (?:it|them|things|everything|each \w+|every \w+) (?:past|by) (?:me|us)|final say|my (?:ok|okay|approval|sign[- ]?off))\b/g, 'approve'],
  // "how much" means price only before is/does/for... ("How much of my time" is the time entry).
  [/\bhow much (is|does|for|do you charge|per)\b/g, 'price $1'], [/\bmy time\b/g, 'mytime'], [/\bhow long\b/g, 'howlong']];
// The inquiry queue in the owner's words (the page says "active inquiries"). Skipped when the question
// mentions a phone or call anywhere: answering calls is not something the page offers, so "pick up the
// phone when i forget to answer" must not read as the inquiry review.
const INQUIRY = /\b(?:inbox(?:es)?|unanswered|unread|backlog|(?:forgot|forget|never|didn'?t|haven'?t) (?:to )?(?:answer(?:ed)?|repl(?:y|ied)|respond(?:ed)?|got back|get back|gotten back|follow(?:ed)? up))\b/g;
const PHONE = /\b(?:phones?|calls?|calling|voicemails?)\b/;
// word -> concept(s)
const SYN = {
  contract: ['contract'], longterm: ['contract'], lockin: ['contract'], commitment: ['contract'], minimum: ['contract'], term: ['contract'],
  monthtomonth: ['contract'], year: ['contract'], howlong: ['contract'],
  anytime: ['cancel'], whenever: ['cancel'], quit: ['cancel'], cancel: ['cancel'], cancellation: ['cancel'], stop: ['cancel'],
  guarantee: ['guarantee'], guaranteed: ['guarantee'], garantee: ['guarantee'], promise: ['guarantee'], roi: ['guarantee'], result: ['guarantee'],
  lead: ['guarantee', 'services'], revenue: ['guarantee'],
  industry: ['industry'], niche: ['industry'], sector: ['industry'], medspa: ['industry'], realestate: ['industry'], fitness: ['industry'],
  studio: ['industry'], rental: ['industry'], wellness: ['industry'],
  ad: ['ads'], ads: ['ads'], advertising: ['ads'], ppc: ['ads'], google: ['ads'], facebook: ['ads'], meta: ['ads'],
  seo: ['seo'], socialmedia: ['social'], social: ['social'], instagram: ['social', 'ads'], tiktok: ['social'], manage: ['social'], ranking: ['seo'],
  film: ['film'], shoot: ['film'], videographer: ['film'], camera: ['film'], video: ['film'], footage: ['film'], clip: ['film'],
  time: ['time'], mytime: ['time'], hour: ['time'], week: ['time'], involved: ['time'], effort: ['time'], workload: ['time'],
  send: ['outreach'], outreach: ['outreach'], email: ['outreach'], message: ['outreach'], dm: ['outreach'], account: ['outreach'],
  pay: ['pay'], payment: ['pay'], billing: ['pay'], bill: ['pay'], invoice: ['pay'], card: ['pay'], stripe: ['pay'], checkout: ['pay'],
  price: ['price'], cost: ['price'], pricing: ['price'], fee: ['price'], charge: ['price'], monthly: ['price'], expensive: ['price'],
  discount: ['discount'], cheaper: ['discount'], negotiable: ['discount'], negotiate: ['discount'], deal: ['discount'], coupon: ['discount'],
  notincluded: ['notincluded'], exclude: ['notincluded'], website: ['website'], web: ['website'],
  area: ['area'], serve: ['area'], located: ['area'], location: ['area'], based: ['area'], where: ['area'], orange: ['area'], county: ['area'],
  angeles: ['area'], inland: ['area'], empire: ['area'], california: ['area'],
  franchise: ['franchise'], chain: ['franchise'],
  free: ['freecheck'], check: ['freecheck'], replytime: ['freecheck'], audit: ['freecheck'],
  approve: ['approve'], approval: ['approve'], permission: ['approve'],
  refund: ['refund'], refunded: ['refund'],
  start: ['start'], signup: ['start'], begin: ['start'],
  text: ['texting'], texting: ['texting'], sms: ['texting'],
  included: ['services'], service: ['services'], deliverable: ['services'], package: ['services'],
  // the page's own words for the six services and the sectors it names (added 2026-10-29, not per-question)
  prospect: ['services'], prospecting: ['services'], referral: ['services'], partner: ['services'], competitor: ['services'],
  inquiry: ['services'], followup: ['services'], content: ['services'], reporting: ['services'], report: ['services'],
  builder: ['industry'], home: ['industry'], custom: ['industry'], event: ['industry'], wedding: ['industry'], venue: ['industry'],
  car: ['industry'], spa: ['industry'], salon: ['industry'], clinic: ['industry'], realtor: ['industry'], broker: ['industry'],
  fit: ['industry'], step: ['start'], process: ['start'], socal: ['area'],
};
// <details> id -> concepts that make it the answer. Each entry's own question adds more at load time.
const TRIG = {
  'faq-price': ['price'], 'faq-contract': ['contract', 'cancel'], 'faq-cancel': ['cancel'], 'faq-refund': ['refund', 'cancel'],
  'faq-discount': ['discount', 'price'], 'faq-pay': ['pay'], 'faq-results': ['guarantee'],
  'faq-services': ['services'], 'faq-not-included': ['notincluded', 'website', 'seo', 'ads'], 'faq-paid-ads': ['ads'],
  'faq-seo-social': ['seo', 'social', 'ads'], 'faq-film': ['film'], 'faq-industry': ['industry'], 'faq-area': ['area'],
  'faq-not-fit': ['franchise'], 'faq-start': ['start'], 'faq-time': ['time'], 'faq-outreach': ['outreach'],
  'faq-approval': ['approve', 'outreach'], 'faq-texting': ['texting'], 'faq-free-check': ['freecheck'],
};
// Questions the homepage must not answer from its own copy (Nick's ruling 2026-10-29): they get the
// Privacy/Terms fallback. Lowercase on purpose; these are matched against what the visitor typed.
const SENSITIVE = new Set(['ai', 'artificial', 'chatgpt', 'gpt', 'robot', 'bot', 'data', 'privacy', 'private', 'hipaa',
  'encrypt', 'encrypted', 'encryption', 'gdpr', 'ccpa', 'confidential', 'security', 'cookie', 'cookies', 'lawyer', 'liability']);
// Not stopwords, but carry no topic: low weight, so they dilute coverage a little, not a lot.
const GENERIC = new Set(('run come take sign send work people client customer everything anything before after go goe out more use make ' +
  'help offer provide other new good ok okay thing someone way able know see look give put doing done say mine much handle cover ' +
  'month mid partial ' +
  // "set up" is mostly the verb ("do you set up texts"); a setup-fee question already says fee/cost/charge.
  'setup').split(' '));

// The box lists the closest FAQ questions as links (Nick's ruling 2026-10-29, option A) and never states
// an answer itself: a single picked answer misled on two blind sets ("filming cost" -> the package price).
// An entry is listed when at least LIST_MIN of the question's weight points at it.
export const LIST_MIN = 0.2;
export const LIST_SIZE = 3;
const MAX_LEN = 300;

const stem = (w) => w.length > 4 && w.endsWith('ies') ? w.slice(0, -3) + 'y' : w.length > 5 && w.endsWith('ing') ? w.slice(0, -3)
  : w.length > 4 && w.endsWith('ed') ? w.slice(0, -2) : w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w;

function dl(a, b) { // Damerau-Levenshtein (optimal string alignment)
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) {
    const c = a[i - 1] === b[j - 1] ? 0 : 1;
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + c);
    if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
  }
  return d[a.length][b.length];
}

const VOCAB = [...new Set([...Object.keys(SYN), 'there', 'cancel', 'time', 'month', 'long', 'term', 'free', 'reply', 'check'])];
// 1-3 letter words are never "corrected" (ads/add, fee/fed); an ambiguous typo stays unknown.
function fixTypo(w) {
  if (SYN[w] || STOP.has(w) || GENERIC.has(w) || SENSITIVE.has(w) || w.length < 4) return w;
  const max = w.length >= 8 ? 2 : 1; let best = null, n = 0;
  for (const v of VOCAB) {
    if (Math.abs(v.length - w.length) > max) continue;
    const k = dl(w, v);
    // A 4-letter word one letter away from a vocabulary word is usually another real word (post/cost,
    // till/bill, near/year): at 4 letters only a swap of two letters ("tiem" -> "time") is a typo.
    if (w.length === 4 && [...w].sort().join('') !== [...v].sort().join('')) continue;
    if (k <= max) { if (!best || k < best.k) { best = { v, k }; n = 1; } else if (k === best.k) n++; }
  }
  return best && n === 1 ? best.v : w;
}

export function analyze(query) {
  let s = (typeof query === 'string' ? query : '').slice(0, MAX_LEN);
  // The page's three regions as owners abbreviate them, expanded to the page's own words before
  // lowercasing: LA and IE only in capitals (lowercase "la" / "i.e." are Spanish and Latin).
  s = s.replace(/(^|[^A-Za-z.])(?:O\.?C\.?)(?![A-Za-z])/gi, '$1 orange county ')
    .replace(/(^|[^A-Za-z.])(?:LA|L\.A\.?)(?![A-Za-z])/g, '$1 los angeles ')
    .replace(/(^|[^A-Za-z.])(?:IE|I\.E\.?)(?![A-Za-z])/g, '$1 inland empire ');
  s = s.toLowerCase().replace(/[‘’]/g, "'");
  s = s.split(/([^a-z0-9']+)/).map((w) => /^[a-z]+$/.test(w) ? fixTypo(w) : w).join('');
  for (const [re, to] of PHRASES) s = s.replace(re, to);
  if (!PHONE.test(s)) s = s.replace(INQUIRY, 'inquiry');
  const raw = s.split(/[^a-z0-9']+/).map((w) => w.replace(/'/g, '')).filter(Boolean);
  // Known words (filler, generic, concept) are kept whole; only unknown words are stemmed and typo-fixed,
  // so "everything" stays generic instead of becoming the unknown "everyth".
  const known = (w) => STOP.has(w) || GENERIC.has(w) || SYN[w];
  const content = raw.filter((w) => !STOP.has(w) && !NEG.has(w) && /[a-z]/.test(w)).map((w) => (known(w) ? w : fixTypo(stem(w))));
  return [...new Set(content)].filter((w) => !STOP.has(w));
}

/**
 * entries: [{ id, q }] — the FAQ ids and question texts as the page has them.
 * Returns ask(query) -> { kind: 'list', ids } (best first, up to LIST_SIZE) | { kind: 'legal' } | { kind: 'none' }.
 */
export function createAsk(entries) {
  const trig = {}, qcon = {};
  for (const e of entries) {
    trig[e.id] = [...(TRIG[e.id] || [])];
    const content = analyze(e.q);
    qcon[e.id] = new Set(content.filter((w) => !GENERIC.has(w)));   // the entry's own question: tie-break
    for (const w of content) for (const c of SYN[w] || []) if (!trig[e.id].includes(c)) trig[e.id].push(c);
  }
  const N = entries.length, df = {};
  for (const e of entries) for (const c of new Set(trig[e.id])) df[c] = (df[c] || 0) + 1;
  const idf = (c) => Math.log(1 + N / (df[c] || 0.5));
  // An unknown word counts against a match at half the rarest concept's weight: real questions carry
  // words the page never uses ("im slammed", "out in riverside"), and at full weight they sank every
  // match (blind set 1: 8/24). Short and generic unknowns count a quarter of that.
  const UNKNOWN_W = 0.5 * Math.log(1 + N / 0.5);
  const unknownWeight = (w) => (GENERIC.has(w) || w.length <= 4) ? 0.25 * UNKNOWN_W : UNKNOWN_W;

  return function ask(query) {
    const content = analyze(query);
    if (!content.length || !entries.length) return { kind: 'none' };
    if (content.some((w) => SENSITIVE.has(w))) return { kind: 'legal' };
    // Each concept counts once, however many words name it ("how much does it cost" is one price
    // question, not two), so one topic can't outvote another topic in the same question.
    const concepts = [...new Set(content.flatMap((w) => SYN[w] || []))];
    const unknown = content.filter((w) => !SYN[w]);
    const total = concepts.reduce((t, c) => t + idf(c), 0) + unknown.reduce((t, w) => t + unknownWeight(w), 0);
    const ranked = entries.map((e) => {
      const got = concepts.filter((c) => trig[e.id].includes(c)).reduce((t, c) => t + idf(c), 0);
      const qo = qcon[e.id].size ? content.filter((w) => qcon[e.id].has(w)).length / qcon[e.id].size : 0;
      return { id: e.id, cov: got / total, qo };
    }).filter((r) => r.cov >= LIST_MIN).sort((a, b) => b.cov - a.cov || b.qo - a.qo);
    return ranked.length ? { kind: 'list', ids: ranked.slice(0, LIST_SIZE).map((r) => r.id) } : { kind: 'none' };
  };
}

// ---- browser wiring (skipped when node imports this file for the eval) ----
function init() {
  const form = document.getElementById('askForm');
  const out = document.getElementById('askOut');
  if (!form || !out) return;
  const items = [...document.querySelectorAll('.faq-list details[id]')];
  const ask = createAsk(items.map((d) => ({ id: d.id, q: d.querySelector('summary').textContent })));
  const tpl = (id) => document.getElementById(id).content.cloneNode(true);
  const reduce = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;

  function fallback(kind, question) {
    out.replaceChildren(tpl(kind === 'legal' ? 'askLegal' : 'askNone'), tpl('askSend'));
    const btn = out.querySelector('[data-act=send]');
    btn.addEventListener('click', () => {
      btn.disabled = true;
      const done = (ok) => btn.parentElement.replaceWith(tpl(ok ? 'askSent' : 'askFail'));
      fetch('/api/faq-question', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ q: question, website_url_confirm: form.website_url_confirm.value }),
      }).then((r) => done(r.ok)).catch(() => done(false));
    });
  }

  // Opening a listed question shows it in place in the FAQ below; the visitor reads the page's own answer.
  function open(d) {
    items.forEach((x) => x.classList.remove('hit'));
    d.open = true; d.classList.add('hit');
    d.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'center' });
    d.querySelector('summary').focus({ preventScroll: true });
  }

  function list(details, question) {
    const card = tpl('askList');
    const ul = card.querySelector('[data-slot=list]');
    for (const d of details) {
      const li = tpl('askHit');
      const a = li.querySelector('a');
      a.textContent = d.querySelector('summary').textContent;
      a.href = '#' + d.id;
      a.addEventListener('click', (e) => { e.preventDefault(); open(d); });
      ul.append(li);
    }
    card.querySelector('[data-act=miss]').addEventListener('click', () => fallback('none', question));
    out.replaceChildren(card);
  }

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const question = form.q.value.trim().slice(0, MAX_LEN);
    if (!question) { out.replaceChildren(); return; }
    const r = ask(question);
    const details = r.kind === 'list' ? r.ids.map((id) => document.getElementById(id)).filter(Boolean) : [];
    if (details.length) list(details, question); else fallback(r.kind, question);
  });
  form.hidden = false;   // shown only once the handler exists; without JS the list below still works
}

if (typeof document !== 'undefined') init();
