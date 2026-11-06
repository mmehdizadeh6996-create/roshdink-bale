/* Roshdink — English Telegram bot
 * Plans, free site analysis, and USDT (TRC-20) payments verified automatically on-chain.
 * Each order gets a unique amount (e.g. 99.137 USDT) sent to ONE wallet, so the bot can match
 * an incoming transfer to the right customer without asking for a TXID, then activates the plan.
 * Needs: TELEGRAM_BOT_TOKEN, ADMIN_IDS, DATABASE_URL, USDT_TRC20_ADDRESS (a wallet used only for this bot).
 */
const http = require('http');
const crypto = require('crypto');

/* ---------- config ---------- */
const TOKEN = process.env.TELEGRAM_BOT_TOKEN || process.env.BOT_TOKEN || '';
const SITE_URL = (process.env.SITE_URL || 'https://roshdink.ir').replace(/\/+$/, '');
const API_BASE = (process.env.API_BASE || SITE_URL).replace(/\/+$/, '');
const TG_API = (process.env.TELEGRAM_API_BASE || 'https://api.telegram.org').replace(/\/+$/, '');
const TRON_API = (process.env.TRON_API_BASE || 'https://api.trongrid.io').replace(/\/+$/, '');
const TRON_KEY = process.env.TRONGRID_API_KEY || '';
const USDT_CONTRACT = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'; // USDT on Tron (TRC-20)
const WALLET = (process.env.USDT_TRC20_ADDRESS || '').trim();
const WALLET_OK = /^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(WALLET);
const ADMIN_IDS = (process.env.ADMIN_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
const PUBLIC_URL = (process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || '').replace(/\/+$/, '');
const MODE = (process.env.BOT_MODE || 'auto').toLowerCase();
const PORT = process.env.PORT || 3000;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || crypto.createHash('sha256').update(TOKEN).digest('hex').slice(0, 24);
const ORDER_TTL_MIN = Number(process.env.ORDER_TTL_MIN || 60);
const POLL_SEC = Math.max(10, Number(process.env.POLL_SEC || 20));
const ANALYZE_LIMIT_PER_HOUR = Number(process.env.ANALYZE_LIMIT_PER_HOUR || 3);
const MIN_REPORT_USDT = 1; // ignore dust transfers when reporting unmatched payments

if (!TOKEN) { console.error('TELEGRAM_BOT_TOKEN is not set.'); process.exit(1); }

/* ---------- small helpers ---------- */
const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString(), ...a);
const isAdmin = id => ADMIN_IDS.includes(String(id));
const esc = s => String(s ?? '').replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const siteLink = (src = 'bot') => `${SITE_URL}/?utm_source=telegram&utm_medium=bot&s=${encodeURIComponent(src)}`;
const usdt = micro => (Number(micro) / 1e6).toFixed(3);
const keyboard = rows => ({ reply_markup: { inline_keyboard: rows } });
const backRow = [{ text: '🏠 Main menu', callback_data: 'menu' }];

async function tg(method, params = {}, timeoutMs = 40000) {
  const r = await fetch(`${TG_API}/bot${TOKEN}/${method}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params), signal: AbortSignal.timeout(timeoutMs),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok || data.ok === false) throw new Error(`${method}: ${data.description || r.status}`);
  return data.result;
}
const send = (chat_id, text, extra = {}) => tg('sendMessage', { chat_id, text, disable_web_page_preview: true, ...extra }).catch(e => { log('send failed', e.message); return null; });
const notifyAdmins = text => Promise.all(ADMIN_IDS.map(a => send(a, text)));

/* ---------- plans ---------- */
const PLANS = [
  { id: 'start', name: 'Start', price: Number(process.env.PRICE_START || 99), tag: 'For new businesses',
    feat: ['Full technical SEO audit (one-time)', 'Keyword research (up to 30 keywords)', 'On-page optimization (up to 10 pages)', '2 SEO-optimized articles per month', 'Monthly performance report'] },
  { id: 'growth', name: 'Growth', price: Number(process.env.PRICE_GROWTH || 249), tag: 'Most popular',
    feat: ['Everything in Start', '8 expert articles per month', 'Targeted internal & external link building', 'Speed & Core Web Vitals improvements', 'Local SEO & Google Maps', 'Strategy call every two weeks'] },
  { id: 'scale', name: 'Scale', price: Number(process.env.PRICE_SCALE || 599), tag: 'For market leaders',
    feat: ['Everything in Growth', 'Dedicated SEO & content team', '20 articles + landing page design', 'Conversion rate optimization (CRO)', 'Competitor analysis & live dashboard', 'Dedicated growth manager, same-day replies'] },
];
const planById = id => PLANS.find(p => p.id === id);
const priceFor = (plan, months) => (months === 3 ? Math.round(plan.price * 3 * 0.85 * 1000) / 1000 : plan.price);

/* ---------- storage (Postgres is required for payments) ---------- */
let pool = null;
async function initStore() {
  if (!process.env.DATABASE_URL) { log('DATABASE_URL is not set: payments are DISABLED (no way to keep orders safely).'); return; }
  const { Pool } = require('pg');
  pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: /localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL) ? false : { rejectUnauthorized: false } });
  await pool.query(`
    CREATE TABLE IF NOT EXISTS tg_users (
      chat_id BIGINT PRIMARY KEY, first_name VARCHAR(100), username VARCHAR(100), source VARCHAR(60),
      analyses INTEGER DEFAULT 0, created_at TIMESTAMPTZ DEFAULT now(), last_seen TIMESTAMPTZ DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS tg_orders (
      id SERIAL PRIMARY KEY, chat_id BIGINT NOT NULL, plan VARCHAR(20) NOT NULL, months INTEGER NOT NULL,
      amount_micro BIGINT NOT NULL, status VARCHAR(10) NOT NULL DEFAULT 'pending',
      txid VARCHAR(80) UNIQUE, site TEXT, created_at TIMESTAMPTZ DEFAULT now(),
      expires_at TIMESTAMPTZ NOT NULL, paid_at TIMESTAMPTZ
    );
    CREATE UNIQUE INDEX IF NOT EXISTS tg_orders_pending_amount ON tg_orders(amount_micro) WHERE status = 'pending';
    CREATE TABLE IF NOT EXISTS tg_subs (
      chat_id BIGINT PRIMARY KEY, plan VARCHAR(20) NOT NULL, expires_at TIMESTAMPTZ NOT NULL, updated_at TIMESTAMPTZ DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS tg_seen_tx (
      txid VARCHAR(80) PRIMARY KEY, from_addr VARCHAR(50), value_micro BIGINT, seen_at TIMESTAMPTZ DEFAULT now()
    );`);
}
const q = (sql, params) => { if (!pool) throw new Error('no database'); return pool.query(sql, params); };

async function touchUser(from, source) {
  if (!from || !pool) return;
  await q(
    `INSERT INTO tg_users(chat_id, first_name, username, source) VALUES($1,$2,$3,$4)
     ON CONFLICT (chat_id) DO UPDATE SET last_seen = now(), first_name = EXCLUDED.first_name, username = EXCLUDED.username`,
    [from.id, (from.first_name || '').slice(0, 100), (from.username || '').slice(0, 100), source || null]).catch(e => log('touchUser', e.message));
}

/* ---------- orders & activation ---------- */
async function createOrder(chatId, plan, months) {
  const base = Math.round(priceFor(plan, months) * 1e6);          // micro-USDT
  for (let i = 0; i < 40; i++) {
    const amount = base + (1 + Math.floor(Math.random() * 999)) * 1000; // +0.001 … +0.999 USDT, unique per pending order
    try {
      await q("UPDATE tg_orders SET status='expired' WHERE chat_id=$1 AND status='pending'", [chatId]); // one open order per user
      const r = await q(
        `INSERT INTO tg_orders(chat_id, plan, months, amount_micro, expires_at) VALUES($1,$2,$3,$4, now() + ($5 || ' minutes')::interval) RETURNING *`,
        [chatId, plan.id, months, amount, String(ORDER_TTL_MIN)]);
      return r.rows[0];
    } catch (e) { if (e.code !== '23505') throw e; }                 // amount already used by another pending order → retry
  }
  throw new Error('could not allocate a unique amount');
}

async function activate(order, txid, late) {
  const plan = planById(order.plan);
  const r = await q(
    `INSERT INTO tg_subs(chat_id, plan, expires_at) VALUES($1,$2, now() + ($3 || ' days')::interval)
     ON CONFLICT (chat_id) DO UPDATE SET plan = EXCLUDED.plan, updated_at = now(),
       expires_at = GREATEST(tg_subs.expires_at, now()) + ($3 || ' days')::interval
     RETURNING expires_at`, [order.chat_id, order.plan, String(order.months * 30)]);
  const until = new Date(r.rows[0].expires_at).toISOString().slice(0, 10);
  pendingSite.set(String(order.chat_id), order.id);
  await send(order.chat_id,
    `✅ Payment received — your ${plan.name} plan is now active until ${until}.\n\n` +
    'To get started, reply with your website address (e.g. example.com) and, if you like, a short note about your goals. Our team will contact you here shortly.',
    keyboard([backRow]));
  const u = (await q('SELECT first_name, username FROM tg_users WHERE chat_id=$1', [order.chat_id])).rows[0] || {};
  await notifyAdmins(`💰 New payment${late ? ' (LATE – order had expired, please double-check)' : ''}\nPlan: ${plan.name} × ${order.months} mo\nAmount: ${usdt(order.amount_micro)} USDT\nUser: ${u.first_name || ''} ${u.username ? '@' + u.username : ''} (${order.chat_id})\nOrder #${order.id}\nTX: ${txid}\nhttps://tronscan.org/#/transaction/${txid}`);
}

/* ---------- on-chain verification (TronGrid) ---------- */
let polling = false;
async function fetchIncoming() {
  const since = Date.now() - 26 * 3600e3;
  const url = `${TRON_API}/v1/accounts/${WALLET}/transactions/trc20?only_to=true&only_confirmed=true&limit=200&order_by=block_timestamp,asc` +
    `&contract_address=${USDT_CONTRACT}&min_timestamp=${since}`;
  const r = await fetch(url, { headers: TRON_KEY ? { 'TRON-PRO-API-KEY': TRON_KEY } : {}, signal: AbortSignal.timeout(25000) });
  const data = await r.json().catch(() => ({}));
  if (!r.ok || data.success === false) throw new Error(`trongrid ${r.status} ${data.error || ''}`);
  return (data.data || []).filter(t => t.to === WALLET && t.token_info?.address === USDT_CONTRACT && t.type === 'Transfer');
}

async function checkPayments() {
  if (!pool || !WALLET_OK || polling) return 0;
  polling = true; let matched = 0;
  try {
    await q("UPDATE tg_orders SET status='expired' WHERE status='pending' AND expires_at < now()");
    const txs = await fetchIncoming();
    for (const t of txs) {
      const value = Number(t.value);
      const ins = await q('INSERT INTO tg_seen_tx(txid, from_addr, value_micro) VALUES($1,$2,$3) ON CONFLICT DO NOTHING', [t.transaction_id, t.from, value]);
      if (!ins.rowCount) continue;                                    // already processed
      let o = (await q("SELECT * FROM tg_orders WHERE status='pending' AND amount_micro=$1", [value])).rows[0], late = false;
      if (!o) { o = (await q("SELECT * FROM tg_orders WHERE status='expired' AND txid IS NULL AND amount_micro=$1 AND expires_at > now() - interval '24 hours' ORDER BY id DESC LIMIT 1", [value])).rows[0]; late = !!o; }
      if (o) {
        const u = await q("UPDATE tg_orders SET status='paid', txid=$2, paid_at=now() WHERE id=$1 AND status IN ('pending','expired') RETURNING *", [o.id, t.transaction_id]);
        if (u.rowCount) { matched++; await activate(u.rows[0], t.transaction_id, late); continue; }
      }
      if (value >= MIN_REPORT_USDT * 1e6) await notifyAdmins(`⚠️ Unmatched USDT transfer\nAmount: ${usdt(value)} USDT\nFrom: ${t.from}\nTX: ${t.transaction_id}\nNo open order has this exact amount. Use /activate <chat_id> <plan> <months> if it belongs to a customer.`);
    }
  } catch (e) { log('checkPayments', e.message); }
  finally { polling = false; }
  return matched;
}
async function pollLoop() {
  for (;;) {
    try { const n = pool && WALLET_OK ? (await q("SELECT COUNT(*)::int AS c FROM tg_orders WHERE status='pending' OR (status='expired' AND txid IS NULL AND expires_at > now() - interval '24 hours')")).rows[0].c : 0; if (n) await checkPayments(); }
    catch (e) { log('pollLoop', e.message); }
    await sleep(POLL_SEC * 1000);
  }
}

/* ---------- conversation state (in memory) ---------- */
const state = new Map();            // chatId -> 'analyze' | 'support'
const pendingSite = new Map();      // chatId -> orderId (waiting for the customer's website after payment)
const rate = new Map();
const pendingBroadcast = new Map(); // adminId -> { text, seg }
const adminAwait = new Map();       // adminId -> segment key
function allowAnalyze(chatId) {
  const now = Date.now(), list = (rate.get(chatId) || []).filter(t => now - t < 3600e3);
  if (list.length >= ANALYZE_LIMIT_PER_HOUR) { rate.set(chatId, list); return false; }
  list.push(now); rate.set(chatId, list); return true;
}

/* ---------- screens ---------- */
const WELCOME = name => `Hi${name ? ' ' + name : ''} 👋\nWelcome to Roshdink.\n\nWe help businesses get found on Google. Here you can:\n• Get a free speed & SEO analysis of your site\n• See our plans and pay with USDT\n• Check your subscription\n• Talk to our team\n\nChoose an option 👇`;
const mainMenu = () => keyboard([
  [{ text: '🔍 Free site analysis', callback_data: 'analyze' }],
  [{ text: '📦 Plans & pricing', callback_data: 'plans' }, { text: '💳 Buy with USDT', callback_data: 'buy' }],
  [{ text: '👤 My subscription', callback_data: 'mysub' }, { text: '💬 Contact support', callback_data: 'support' }],
  [{ text: '🌐 Website', url: siteLink('menu') }],
]);
const showMenu = (chatId, name) => { state.delete(chatId); return send(chatId, WELCOME(name), mainMenu()); };

const planText = p => `📦 ${p.name} plan — ${p.tag}\n💰 ${p.price} USDT / month\n` + p.feat.map(f => '• ' + f).join('\n');
const showPlans = chatId => send(chatId, PLANS.map(planText).join('\n\n──────────\n\n') + '\n\n✨ Pay for 3 months and save 15%.',
  keyboard([[{ text: '💳 Buy with USDT', callback_data: 'buy' }], backRow]));

async function showBuy(chatId) {
  if (!pool || !WALLET_OK) return send(chatId, 'Payments are temporarily unavailable. Please contact support.', keyboard([[{ text: '💬 Contact support', callback_data: 'support' }], backRow]));
  return send(chatId, 'Choose a plan:', keyboard([...PLANS.map(p => [{ text: `${p.name} — ${p.price} USDT/mo`, callback_data: `p:${p.id}` }]), backRow]));
}
async function showDuration(chatId, planId) {
  const p = planById(planId); if (!p) return;
  return send(chatId, `${p.name} plan — how long?`, keyboard([
    [{ text: `1 month — ${priceFor(p, 1)} USDT`, callback_data: `d:${p.id}:1` }],
    [{ text: `3 months — ${priceFor(p, 3)} USDT (save 15%)`, callback_data: `d:${p.id}:3` }],
    [{ text: '⬅️ Back', callback_data: 'buy' }]]));
}
async function startOrder(chatId, planId, months) {
  const p = planById(planId); if (!p || ![1, 3].includes(months) || !pool || !WALLET_OK) return;
  const o = await createOrder(chatId, p, months);
  const text = `🧾 <b>Order #${o.id}</b> — ${esc(p.name)} × ${months} month${months > 1 ? 's' : ''}\n\n` +
    `Send exactly:\n<code>${usdt(o.amount_micro)}</code> USDT\n\nNetwork: <b>TRON (TRC-20)</b> only\nTo address:\n<code>${WALLET}</code>\n\n` +
    `⚠️ The amount must match <b>exactly</b> (all decimals) — that's how we recognise your payment. Other networks or amounts can't be matched automatically.\n` +
    `⏳ Valid for ${ORDER_TTL_MIN} minutes. Your plan activates automatically about a minute after the transfer is confirmed.`;
  return send(chatId, text, { parse_mode: 'HTML', ...keyboard([[{ text: '✅ I\'ve paid — check now', callback_data: `chk:${o.id}` }], [{ text: '✖️ Cancel order', callback_data: `can:${o.id}` }]]) });
}
async function checkOrder(chatId, id) {
  const o = (await q('SELECT * FROM tg_orders WHERE id=$1 AND chat_id=$2', [id, chatId])).rows[0];
  if (!o) return send(chatId, 'Order not found.');
  if (o.status === 'paid') return send(chatId, '✅ This order is already paid and active.', keyboard([[{ text: '👤 My subscription', callback_data: 'mysub' }], backRow]));
  if (o.status === 'pending') { await checkPayments(); const o2 = (await q('SELECT status FROM tg_orders WHERE id=$1', [id])).rows[0]; if (o2.status === 'paid') return; }
  const fresh = (await q('SELECT status FROM tg_orders WHERE id=$1', [id])).rows[0];
  if (fresh.status === 'pending') return send(chatId, '⏳ Not received yet. Transfers are detected once they are confirmed on the TRON network (usually 1–3 minutes). Try again shortly.', keyboard([[{ text: '🔄 Check again', callback_data: `chk:${id}` }]]));
  return send(chatId, 'This order has expired. Start a new one when you are ready.', keyboard([[{ text: '💳 Buy with USDT', callback_data: 'buy' }], backRow]));
}
async function cancelOrder(chatId, id) {
  await q("UPDATE tg_orders SET status='expired' WHERE id=$1 AND chat_id=$2 AND status='pending'", [id, chatId]);
  return send(chatId, 'Order cancelled.', keyboard([backRow]));
}
async function showSub(chatId) {
  if (!pool) return send(chatId, 'Subscriptions are unavailable right now.', keyboard([backRow]));
  const s = (await q('SELECT plan, expires_at FROM tg_subs WHERE chat_id=$1', [chatId])).rows[0];
  if (!s || new Date(s.expires_at) < new Date()) return send(chatId, s ? `Your ${planById(s.plan)?.name || s.plan} plan expired on ${new Date(s.expires_at).toISOString().slice(0, 10)}.` : 'You have no active subscription yet.', keyboard([[{ text: '💳 Buy with USDT', callback_data: 'buy' }], backRow]));
  return send(chatId, `👤 Your plan: ${planById(s.plan)?.name || s.plan}\n✅ Active until ${new Date(s.expires_at).toISOString().slice(0, 10)}`, keyboard([[{ text: '🔁 Renew / extend', callback_data: 'buy' }], backRow]));
}

/* ---------- free site analysis (same API as the website) ---------- */
function extractHost(text) {
  const m = String(text).trim().match(/(?:https?:\/\/)?(?:www\.)?([a-z0-9-]+(?:\.[a-z0-9-]+)+)/i);
  return m ? m[1].toLowerCase() : null;
}
const icon = n => (n == null ? '⚪' : n >= 90 ? '🟢' : n >= 50 ? '🟠' : '🔴');
const sc = n => (n == null ? '—' : n);
const askAnalyze = chatId => { state.set(chatId, 'analyze'); return send(chatId, 'Send your website address 🔍\nFor example: example.com', keyboard([backRow])); };
async function runAnalyze(chatId, text) {
  const host = extractHost(text);
  if (!host) return send(chatId, 'That doesn\'t look like a website address 🤔\nTry: example.com', keyboard([backRow]));
  if (!allowAnalyze(chatId)) { state.delete(chatId); return send(chatId, `To keep the service fast, each person can run ${ANALYZE_LIMIT_PER_HOUR} analyses per hour. Please try again a bit later 🙏`, keyboard([[{ text: '🌐 Analyze on the website', url: siteLink('limit') }], backRow])); }
  state.delete(chatId);
  await send(chatId, `⏳ Analyzing ${host}… this usually takes under a minute.`);
  try {
    const r = await fetch(`${API_BASE}/api/analyze`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ domain: host }), signal: AbortSignal.timeout(150000) });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || `status ${r.status}`);
    const m = data.mobile || {}, d = data.desktop || {}, ms = m.scores || {}, ds = d.scores || {};
    const vals = [ms.performance, ms.accessibility, ms.bestPractices, ms.seo].filter(x => typeof x === 'number');
    const overall = vals.length ? Math.round(vals.reduce((a, b) => a + b, 0) / vals.length) : null;
    const rec = overall == null ? PLANS[1] : overall < 45 ? PLANS[2] : overall < 68 ? PLANS[1] : PLANS[0];
    const issues = (m.topIssues || []).slice(0, 3).map(i => '• ' + i.title).join('\n');
    const out = `📊 Analysis for ${data.host || host}\n\n📱 Mobile\n${icon(ms.performance)} Speed: ${sc(ms.performance)}\n${icon(ms.seo)} SEO: ${sc(ms.seo)}\n${icon(ms.bestPractices)} Best practices: ${sc(ms.bestPractices)}\n${icon(ms.accessibility)} Accessibility: ${sc(ms.accessibility)}\n\n💻 Desktop\n${icon(ds.performance)} Speed: ${sc(ds.performance)}   ${icon(ds.seo)} SEO: ${sc(ds.seo)}\n\n` +
      (issues ? `🔧 Top things to improve:\n${issues}\n\n` : '') + `✅ Suggested plan: ${rec.name}`;
    return send(chatId, out, keyboard([[{ text: '📦 See plans', callback_data: 'plans' }, { text: '💳 Buy with USDT', callback_data: 'buy' }], [{ text: '🌐 Full report on the website', url: siteLink('analysis') }], backRow]));
  } catch (e) {
    log('analyze failed', host, e.message);
    return send(chatId, 'Couldn\'t analyze that site right now 😕 It may be unreachable or Google\'s service is busy. Please try again in a few minutes.', keyboard([[{ text: '🌐 Analyze on the website', url: siteLink('fail') }], backRow]));
  }
}

/* ---------- admin ---------- */
const SEGMENTS = {
  all:   { label: '👥 All users', sql: 'TRUE' },
  today: { label: '🆕 Joined today', sql: "created_at > now() - interval '1 day'" },
  subs:  { label: '✅ Active subscribers', sql: 'chat_id IN (SELECT chat_id FROM tg_subs WHERE expires_at > now())' },
  free:  { label: '🆓 Never paid', sql: 'chat_id NOT IN (SELECT chat_id FROM tg_orders WHERE status=\'paid\')' },
};
async function dashboard(chatId) {
  if (!pool) return send(chatId, 'No database connected.');
  const [u, o, s] = await Promise.all([
    q(`SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE created_at > now() - interval '1 day')::int AS today, COUNT(*) FILTER (WHERE created_at > now() - interval '7 days')::int AS week, COUNT(*) FILTER (WHERE last_seen > now() - interval '1 day')::int AS active FROM tg_users`),
    q("SELECT COUNT(*) FILTER (WHERE status='paid')::int AS paid, COUNT(*) FILTER (WHERE status='pending')::int AS pending, COALESCE(SUM(amount_micro) FILTER (WHERE status='paid'),0)::bigint AS revenue FROM tg_orders"),
    q('SELECT COUNT(*)::int AS c FROM tg_subs WHERE expires_at > now()')]);
  const a = u.rows[0], b = o.rows[0];
  const text = `📊 Dashboard\n\n👥 Users: ${a.total}\n🆕 Today: ${a.today}   🗓 7 days: ${a.week}\n🟢 Active (24h): ${a.active}\n\n✅ Active subscribers: ${s.rows[0].c}\n💰 Paid orders: ${b.paid}   ⏳ Pending: ${b.pending}\n💵 Revenue: ${usdt(b.revenue)} USDT\n\nWallet: ${WALLET_OK ? WALLET : '⚠️ NOT SET'}`;
  return send(chatId, text, keyboard([
    [{ text: '🧾 Recent orders', callback_data: 'adm:orders' }, { text: '✅ Subscribers', callback_data: 'adm:subs' }],
    [{ text: '📢 To all', callback_data: 'adm:bc:all' }, { text: '📢 To today\'s users', callback_data: 'adm:bc:today' }],
    [{ text: '📢 To subscribers', callback_data: 'adm:bc:subs' }, { text: '📢 To never-paid', callback_data: 'adm:bc:free' }]]));
}
async function adminLists(chatId, kind) {
  if (kind === 'orders') {
    const r = (await q('SELECT o.id, o.plan, o.months, o.amount_micro, o.status, o.chat_id, u.username FROM tg_orders o LEFT JOIN tg_users u USING(chat_id) ORDER BY o.id DESC LIMIT 15')).rows;
    return send(chatId, r.length ? '🧾 Recent orders\n\n' + r.map(x => `#${x.id} ${x.status.toUpperCase()} · ${x.plan}×${x.months} · ${usdt(x.amount_micro)} USDT · ${x.username ? '@' + x.username : x.chat_id}`).join('\n') : 'No orders yet.', keyboard([[{ text: '🔙 Dashboard', callback_data: 'adm:dash' }]]));
  }
  const r = (await q('SELECT s.chat_id, s.plan, s.expires_at, u.username, u.first_name FROM tg_subs s LEFT JOIN tg_users u USING(chat_id) WHERE s.expires_at > now() ORDER BY s.expires_at LIMIT 30')).rows;
  return send(chatId, r.length ? '✅ Active subscribers (soonest expiry first)\n\n' + r.map(x => `${x.username ? '@' + x.username : x.first_name || x.chat_id} · ${x.plan} · until ${new Date(x.expires_at).toISOString().slice(0, 10)}`).join('\n') : 'No active subscribers.', keyboard([[{ text: '🔙 Dashboard', callback_data: 'adm:dash' }]]));
}
const segIds = async key => (SEGMENTS[key] ? (await q(`SELECT chat_id FROM tg_users WHERE ${SEGMENTS[key].sql}`)).rows.map(r => Number(r.chat_id)) : []);
async function doBroadcast(adminId) {
  const p = pendingBroadcast.get(String(adminId)); pendingBroadcast.delete(String(adminId));
  if (!p) return send(adminId, 'Nothing to send.');
  const ids = await segIds(p.seg); let ok = 0, fail = 0;
  await send(adminId, `⏳ Sending to ${ids.length} users…`);
  for (const id of ids) { const r = await send(id, p.text, keyboard([[{ text: '🔍 Free site analysis', callback_data: 'analyze' }, { text: '🌐 Website', url: siteLink('broadcast') }]])); r ? ok++ : fail++; await sleep(60); }
  return send(adminId, `✅ Done.\nDelivered: ${ok}\nFailed (e.g. blocked the bot): ${fail}`);
}
async function adminCommand(chatId, text) {
  const [cmd, ...rest] = text.split(/\s+/);
  if (cmd === '/dashboard' || cmd === '/stats') return dashboard(chatId);
  if (cmd === '/orders') return adminLists(chatId, 'orders');
  if (cmd === '/check') { const n = await checkPayments(); return send(chatId, `Checked the chain. Matched payments: ${n}`); }
  if (cmd === '/activate') {            // /activate <chat_id> <plan> <months>   (manual fallback)
    const [id, planId, m] = rest, plan = planById(planId), months = Number(m || 1);
    if (!/^\d+$/.test(id || '') || !plan || ![1, 3].includes(months)) return send(chatId, 'Usage: /activate <chat_id> <start|growth|scale> <1|3>');
    const o = (await q("INSERT INTO tg_orders(chat_id, plan, months, amount_micro, status, expires_at, paid_at) VALUES($1,$2,$3,0,'paid', now(), now()) RETURNING *", [id, plan.id, months])).rows[0];
    await activate(o, 'manual-' + o.id, false);
    return send(chatId, `Activated ${plan.name} × ${months} for ${id}.`);
  }
  return false;
}

/* ---------- routing ---------- */
async function onCallback(cb) {
  const chatId = cb.message?.chat?.id || cb.from?.id, data = cb.data || '';
  tg('answerCallbackQuery', { callback_query_id: cb.id }).catch(() => {});
  await touchUser(cb.from);
  if (isAdmin(cb.from?.id)) {
    if (data === 'adm:dash') return dashboard(chatId);
    if (data === 'adm:orders') return adminLists(chatId, 'orders');
    if (data === 'adm:subs') return adminLists(chatId, 'subs');
    if (data.startsWith('adm:bc:')) { const key = data.slice(7); if (!SEGMENTS[key]) return; const n = (await segIds(key)).length; if (!n) return send(chatId, 'That group is empty.'); adminAwait.set(String(chatId), key); return send(chatId, `Write the message for “${SEGMENTS[key].label}” (${n} users) and send it.\nTo cancel: /cancel`); }
    if (data === 'bc_yes') return doBroadcast(cb.from.id);
    if (data === 'bc_no') { pendingBroadcast.delete(String(cb.from.id)); return send(chatId, 'Cancelled.'); }
  }
  if (data === 'menu') return showMenu(chatId, cb.from?.first_name);
  if (data === 'analyze') return askAnalyze(chatId);
  if (data === 'plans') return showPlans(chatId);
  if (data === 'buy') return showBuy(chatId);
  if (data === 'mysub') return showSub(chatId);
  if (data === 'support') { state.set(chatId, 'support'); return send(chatId, 'Write your message and our team will reply here.', keyboard([backRow])); }
  if (data.startsWith('p:')) return showDuration(chatId, data.slice(2));
  if (data.startsWith('d:')) { const [, pid, m] = data.split(':'); return startOrder(chatId, pid, Number(m)); }
  if (data.startsWith('chk:')) return checkOrder(chatId, Number(data.slice(4)));
  if (data.startsWith('can:')) return cancelOrder(chatId, Number(data.slice(4)));
}

async function onMessage(msg) {
  const chatId = msg.chat?.id; if (!chatId || (msg.chat.type && msg.chat.type !== 'private')) return;
  const text = (msg.text || '').trim(), from = msg.from;
  if (text.startsWith('/start')) { const payload = text.split(/\s+/)[1]; await touchUser(from, payload ? payload.slice(0, 60) : null); return showMenu(chatId, from?.first_name); }
  await touchUser(from);
  const who = `${from?.first_name || ''} ${from?.username ? '@' + from.username : ''} (${chatId})`;
  if (isAdmin(from?.id)) {
    const key = adminAwait.get(String(chatId));
    if (key) {
      if (text === '/cancel') { adminAwait.delete(String(chatId)); return send(chatId, 'Cancelled.'); }
      if (text && !text.startsWith('/')) { adminAwait.delete(String(chatId)); pendingBroadcast.set(String(chatId), { text, seg: key }); const n = (await segIds(key)).length; return send(chatId, `Preview (to ${n} users, “${SEGMENTS[key].label}”):\n\n${text}`, keyboard([[{ text: '✅ Send', callback_data: 'bc_yes' }, { text: '✖️ Cancel', callback_data: 'bc_no' }]])); }
    }
    if (/^\/(dashboard|stats|orders|check|activate)\b/.test(text)) { if (await adminCommand(chatId, text) !== false) return; }
    // admin replies to a forwarded customer message: "/reply <chat_id> text"
    const m = text.match(/^\/reply\s+(\d+)\s+([\s\S]+)/); if (m) { await send(m[1], m[2]); return send(chatId, 'Sent.'); }
  }
  if (text === '/menu' || text === '/help') return showMenu(chatId, from?.first_name);
  if (text === '/plans') return showPlans(chatId);
  if (text === '/buy') return showBuy(chatId);
  if (text === '/analyze') return askAnalyze(chatId);
  if (pendingSite.has(String(chatId)) && text && !text.startsWith('/')) {
    const oid = pendingSite.get(String(chatId)); pendingSite.delete(String(chatId));
    if (pool) await q('UPDATE tg_orders SET site=$2 WHERE id=$1 AND chat_id=$3', [oid, text.slice(0, 500), chatId]).catch(() => {});
    await notifyAdmins(`🌐 Onboarding details from ${who} (order #${oid}):\n\n${text}\n\nReply with: /reply ${chatId} <message>`);
    return send(chatId, 'Thanks! Our team has your details and will be in touch here soon. 🙌', keyboard([backRow]));
  }
  const st = state.get(chatId);
  if (st === 'support' && text && !text.startsWith('/')) { state.delete(chatId); await notifyAdmins(`💬 Support message from ${who}:\n\n${text}\n\nReply with: /reply ${chatId} <message>`); return send(chatId, 'Message sent ✅ We\'ll reply here soon.', keyboard([backRow])); }
  if (st === 'analyze') return runAnalyze(chatId, text);
  if (!text) return;
  if (extractHost(text)) return runAnalyze(chatId, text);
  return send(chatId, 'Choose an option from the menu 👇', mainMenu());
}

async function handleUpdate(u) {
  try { if (u.callback_query) await onCallback(u.callback_query); else if (u.message) await onMessage(u.message); }
  catch (e) {
    log('update error', e.message);
    const cid = u.callback_query?.message?.chat?.id || u.message?.chat?.id;
    if (cid) send(cid, e.message === 'no database' ? 'Payments are temporarily unavailable. Please contact support.' : 'Something went wrong. Please try again in a moment.', keyboard([backRow]));
  }
}

/* ---------- run: webhook or polling ---------- */
async function startPolling() {
  await tg('deleteWebhook').catch(() => {});
  log('polling mode');
  let offset = 0;
  for (;;) {
    try { const ups = await tg('getUpdates', { offset, timeout: 25 }, 40000); for (const u of ups || []) { offset = u.update_id + 1; handleUpdate(u); } }
    catch (e) { log('getUpdates', e.message); await sleep(3000); }
  }
}
async function main() {
  await initStore();
  if (pool && !WALLET_OK) log('USDT_TRC20_ADDRESS is missing or invalid: payments disabled.');
  const server = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === `/webhook/${WEBHOOK_SECRET}`) {
      let body = ''; req.on('data', c => { body += c; if (body.length > 1e6) req.destroy(); });
      req.on('end', () => { res.writeHead(200).end('ok'); try { handleUpdate(JSON.parse(body)); } catch {} });
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' }).end('roshdink telegram bot is running');
  });
  server.listen(PORT, () => log(`server on port ${PORT}`));
  pollLoop();
  const useWebhook = MODE === 'webhook' || (MODE === 'auto' && PUBLIC_URL);
  if (useWebhook) {
    try { await tg('setWebhook', { url: `${PUBLIC_URL}/webhook/${WEBHOOK_SECRET}`, allowed_updates: ['message', 'callback_query'] }); log('webhook set'); return; }
    catch (e) { log('setWebhook failed, falling back to polling:', e.message); }
  }
  startPolling();
}
if (require.main === module || process.env.PLATFORM === 'telegram') main().catch(e => { console.error(e); process.exit(1); });
module.exports = { checkPayments, createOrder, activate };
