/* ربات رشدینک (بله / تلگرام؛ با PLATFORM انتخاب می‌شود) — معرفی، تحلیل رایگان سایت، پلن‌ها، کد تخفیف، مشاوره و ارسال تبلیغات
 * بدون وابستگی اجباری؛ فقط اگر DATABASE_URL بدهی از pg استفاده می‌کند.
 */
const http = require('http');
const crypto = require('crypto');

/* Telegram = English bot with USDT payments (separate file) */
if ((process.env.PLATFORM || '').toLowerCase() === 'telegram') { require('./telegram-usdt-bot.js'); return; }

/* ---------- تنظیمات ---------- */
const PLATFORM = (process.env.PLATFORM || 'bale').toLowerCase() === 'telegram' ? 'telegram' : 'bale';
const IS_TG = PLATFORM === 'telegram';
const TOKEN = (IS_TG ? process.env.TELEGRAM_BOT_TOKEN : process.env.BALE_BOT_TOKEN) || process.env.BOT_TOKEN || '';
const T_USERS = IS_TG ? 'tg_users' : 'bale_users', T_LEADS = IS_TG ? 'tg_leads' : 'bale_leads';
const SITE_URL = (process.env.SITE_URL || 'https://roshdink.ir').replace(/\/+$/, '');
const API_BASE = (process.env.API_BASE || SITE_URL).replace(/\/+$/, '');
const BALE_API_BASE = (IS_TG ? (process.env.TELEGRAM_API_BASE || 'https://api.telegram.org') : (process.env.BALE_API_BASE || 'https://tapi.bale.ai')).replace(/\/+$/, '');
const ADMIN_IDS = (process.env.ADMIN_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
const PUBLIC_URL = (process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || '').replace(/\/+$/, '');
const MODE = (process.env.BOT_MODE || 'auto').toLowerCase(); // auto | webhook | polling
const PORT = process.env.PORT || 3000;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || crypto.createHash('sha256').update(TOKEN).digest('hex').slice(0, 24);
const ANALYZE_LIMIT_PER_HOUR = Number(process.env.ANALYZE_LIMIT_PER_HOUR || 3);

if (!TOKEN) { console.error((IS_TG ? 'TELEGRAM_BOT_TOKEN' : 'BALE_BOT_TOKEN') + ' تنظیم نشده است.'); process.exit(1); }

/* ---------- ابزارهای کوچک ---------- */
const faDigits = s => String(s).replace(/\d/g, d => '۰۱۲۳۴۵۶۷۸۹'[d]);
const fmt = n => faDigits(Number(n).toLocaleString('en-US'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const siteLink = (src = PLATFORM) => `${SITE_URL}/?utm_source=${PLATFORM}&utm_medium=bot&s=${encodeURIComponent(src)}`;
const isAdmin = id => ADMIN_IDS.includes(String(id));
const log = (...a) => console.log(new Date().toISOString(), ...a);

/* ---------- API بله ---------- */
async function bale(method, params = {}, timeoutMs = 40000) {
  const r = await fetch(`${BALE_API_BASE}/bot${TOKEN}/${method}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params), signal: AbortSignal.timeout(timeoutMs),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok || data.ok === false) throw new Error(`${method}: ${data.description || r.status}`);
  return data.result;
}
const send = (chat_id, text, extra = {}) => bale('sendMessage', { chat_id, text, ...extra }).catch(e => log('send failed', e.message));
const keyboard = rows => ({ reply_markup: { inline_keyboard: rows } });

/* ---------- ذخیره‌سازی (pg یا حافظه) ---------- */
let pool = null;
const mem = { users: new Map(), leads: [], analyses: 0 };
async function initStore() {
  if (!process.env.DATABASE_URL) { log('DATABASE_URL ندارد؛ کاربران فقط در حافظه نگه داشته می‌شوند (با ری‌استارت پاک می‌شوند).'); return; }
  const { Pool } = require('pg');
  pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  const _q = pool.query.bind(pool);   // جدول‌های هر پلتفرم جدا هستند (bale_* یا tg_*)
  pool.query = (sql, ...a) => _q(typeof sql === 'string' ? sql.replace(/bale_users/g, T_USERS).replace(/bale_leads/g, T_LEADS) : sql, ...a);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS bale_users (
      chat_id BIGINT PRIMARY KEY, first_name VARCHAR(100), username VARCHAR(100), source VARCHAR(60),
      analyses INTEGER DEFAULT 0, created_at TIMESTAMPTZ DEFAULT now(), last_seen TIMESTAMPTZ DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS bale_leads (
      id SERIAL PRIMARY KEY, chat_id BIGINT, phone VARCHAR(20), note TEXT, created_at TIMESTAMPTZ DEFAULT now()
    );`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS bale_tickets (
      id SERIAL PRIMARY KEY, chat_id BIGINT NOT NULL, name VARCHAR(200), status VARCHAR(10) NOT NULL DEFAULT 'open',
      created_at TIMESTAMPTZ DEFAULT now(), updated_at TIMESTAMPTZ DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS bale_ticket_msgs (
      id SERIAL PRIMARY KEY, ticket_id INTEGER NOT NULL, sender VARCHAR(10) NOT NULL, body TEXT NOT NULL, created_at TIMESTAMPTZ DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS bale_tickets_chat ON bale_tickets(chat_id);
    CREATE INDEX IF NOT EXISTS bale_ticket_msgs_t ON bale_ticket_msgs(ticket_id);`);
  await pool.query(`
    ALTER TABLE bale_users ADD COLUMN IF NOT EXISTS fu_stage INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE bale_users ADD COLUMN IF NOT EXISTS fu_next TIMESTAMPTZ;
    ALTER TABLE bale_users ADD COLUMN IF NOT EXISTS fu_stop VARCHAR(20);
    ALTER TABLE bale_users ADD COLUMN IF NOT EXISTS fu_code VARCHAR(30);
    ALTER TABLE bale_users ADD COLUMN IF NOT EXISTS fu_code_exp TIMESTAMPTZ;
    ALTER TABLE bale_users ADD COLUMN IF NOT EXISTS fu_host TEXT;
    ALTER TABLE bale_users ADD COLUMN IF NOT EXISTS fu_score INTEGER;
    ALTER TABLE bale_users ADD COLUMN IF NOT EXISTS fu_issue TEXT;
    ALTER TABLE bale_users ADD COLUMN IF NOT EXISTS fu_plan VARCHAR(10);
    CREATE INDEX IF NOT EXISTS bale_users_fu ON bale_users(fu_next) WHERE fu_stop IS NULL;`);
}
async function touchUser(from, source) {
  if (!from) return;
  const id = from.id, name = (from.first_name || '').slice(0, 100), uname = (from.username || '').slice(0, 100);
  if (!pool) {
    const u = mem.users.get(id) || { id, first_name: name, username: uname, source: source || null, created: Date.now() };
    u.last = Date.now(); mem.users.set(id, u); return;
  }
  await pool.query(
    `INSERT INTO bale_users(chat_id, first_name, username, source, fu_next) VALUES($1,$2,$3,$4, now() + interval '3 hours')
     ON CONFLICT (chat_id) DO UPDATE SET last_seen=now(), first_name=EXCLUDED.first_name, username=EXCLUDED.username`,
    [id, name, uname, source || null]).catch(e => log('touchUser', e.message));
}
async function addLead(chat_id, phone, note) {
  if (!pool) { mem.leads.push({ chat_id, phone, note, at: new Date() }); return; }
  await pool.query('INSERT INTO bale_leads(chat_id, phone, note) VALUES($1,$2,$3)', [chat_id, phone, note || null]);
}
async function countAnalysis(chat_id) {
  if (!pool) { mem.analyses++; return; }
  await pool.query('UPDATE bale_users SET analyses = analyses + 1 WHERE chat_id=$1', [chat_id]).catch(() => {});
}
async function allUserIds() {
  if (!pool) return [...mem.users.keys()];
  return (await pool.query('SELECT chat_id FROM bale_users')).rows.map(r => Number(r.chat_id));
}
async function stats() {
  if (!pool) return { users: mem.users.size, leads: mem.leads.length, analyses: mem.analyses, sources: {} };
  const u = await pool.query('SELECT COUNT(*)::int c, COALESCE(SUM(analyses),0)::int a FROM bale_users');
  const l = await pool.query('SELECT COUNT(*)::int c FROM bale_leads');
  const s = await pool.query("SELECT COALESCE(source,'مستقیم') src, COUNT(*)::int c FROM bale_users GROUP BY 1 ORDER BY c DESC LIMIT 8");
  return { users: u.rows[0].c, leads: l.rows[0].c, analyses: u.rows[0].a, sources: Object.fromEntries(s.rows.map(r => [r.src, r.c])) };
}
async function dashboard() {
  const DAY = 86400000;
  if (!pool) {
    const us = [...mem.users.values()], now = Date.now();
    const cnt = ms => us.filter(u => now - u.created < ms).length;
    const act = ms => us.filter(u => now - (u.last || u.created) < ms).length;
    const base = await stats();
    return { ...base, today: cnt(DAY), week: cnt(7 * DAY), month: cnt(30 * DAY), active24: act(DAY), active7: act(7 * DAY), days: [], recent: us.slice(-5).reverse().map(u => ({ first_name: u.first_name, username: u.username, source: u.source })) };
  }
  const base = await stats();
  const t = await pool.query(`SELECT
    COUNT(*) FILTER (WHERE created_at > now() - interval '1 day')::int AS today,
    COUNT(*) FILTER (WHERE created_at > now() - interval '7 days')::int AS week,
    COUNT(*) FILTER (WHERE created_at > now() - interval '30 days')::int AS month,
    COUNT(*) FILTER (WHERE last_seen > now() - interval '1 day')::int AS active24,
    COUNT(*) FILTER (WHERE last_seen > now() - interval '7 days')::int AS active7
    FROM bale_users`);
  const d = await pool.query(`SELECT to_char(created_at AT TIME ZONE 'Asia/Tehran','MM/DD') AS day, COUNT(*)::int AS c FROM bale_users
    WHERE created_at > now() - interval '7 days' GROUP BY 1 ORDER BY 1 DESC`);
  const r = await pool.query('SELECT first_name, username, source FROM bale_users ORDER BY created_at DESC LIMIT 5');
  return { ...base, ...t.rows[0], days: d.rows, recent: r.rows };
}
/* ---------- بخش‌بندی کاربران (داشبورد) ---------- */
const tehranDayStart = () => { const t = Date.now() + 12600e3; return Math.floor(t / 864e5) * 864e5 - 12600e3; };
const SEGMENTS = {
  all:      { label: '👥 همه‌ی کاربران', sql: 'TRUE', test: () => true },
  today:    { label: '🆕 امروز', sql: "(created_at AT TIME ZONE 'Asia/Tehran') >= date_trunc('day', now() AT TIME ZONE 'Asia/Tehran')", test: u => u.created >= tehranDayStart() },
  week:     { label: '🗓 ۷ روز اخیر', sql: "created_at > now() - interval '7 days'", test: u => Date.now() - u.created < 7 * 864e5 },
  month:    { label: '📆 ۳۰ روز اخیر', sql: "created_at > now() - interval '30 days'", test: u => Date.now() - u.created < 30 * 864e5 },
  act1:     { label: '🟢 فعال ۲۴ ساعت', sql: "last_seen > now() - interval '1 day'", test: u => Date.now() - (u.last || u.created) < 864e5 },
  act7:     { label: '🟢 فعال ۷ روز', sql: "last_seen > now() - interval '7 days'", test: u => Date.now() - (u.last || u.created) < 7 * 864e5 },
  leads:    { label: '📞 درخواست مشاوره', sql: 'chat_id IN (SELECT chat_id FROM bale_leads)', test: u => mem.leads.some(l => l.chat_id === u.id) },
  analyzed: { label: '🔍 تحلیل گرفته‌ها', sql: 'analyses > 0', test: () => false },
};
const memSeg = key => [...mem.users.values()].filter(SEGMENTS[key].test).sort((a, b) => b.created - a.created)
  .map(u => ({ chat_id: u.id, first_name: u.first_name, username: u.username, source: u.source, created_at: u.created }));
async function segCounts() {
  if (!pool) return Object.fromEntries(Object.keys(SEGMENTS).map(k => [k, memSeg(k).length]));
  const ks = Object.keys(SEGMENTS);
  const rs = await Promise.all(ks.map(k => pool.query(`SELECT COUNT(*)::int AS c FROM bale_users WHERE ${SEGMENTS[k].sql}`)));
  return Object.fromEntries(ks.map((k, i) => [k, rs[i].rows[0].c]));
}
async function segUsers(key, page, per) {
  if (!pool) return memSeg(key).slice(page * per, page * per + per);
  return (await pool.query(`SELECT chat_id, first_name, username, source, created_at FROM bale_users WHERE ${SEGMENTS[key].sql} ORDER BY created_at DESC LIMIT $1 OFFSET $2`, [per, page * per])).rows;
}
async function segIds(key) {
  if (!SEGMENTS[key]) return [];
  if (!pool) return memSeg(key).map(u => u.chat_id);
  return (await pool.query(`SELECT chat_id FROM bale_users WHERE ${SEGMENTS[key].sql}`)).rows.map(r => Number(r.chat_id));
}
async function lastLeads() {
  if (!pool) return mem.leads.slice(-10).reverse();
  return (await pool.query('SELECT chat_id, phone, note, created_at AS at FROM bale_leads ORDER BY id DESC LIMIT 10')).rows;
}

/* ---------- محتوا ---------- */
const PLANS = [
  { id: 'start', name: 'شروع', price: 9800000, tag: 'برای کسب‌وکارهای نوپا',
    feat: ['ممیزی کامل سئو فنی (یک‌بار)', 'تحقیق کلمات کلیدی تا ۳۰ عبارت', 'بهینه‌سازی on-page تا ۱۰ صفحه', '۲ محتوای سئوشده در ماه', 'گزارش ماهانه عملکرد'] },
  { id: 'growth', name: 'رشد', price: 24500000, tag: 'محبوب‌ترین انتخاب',
    feat: ['همه‌ی امکانات پلن شروع', '۸ محتوای تخصصی در ماه', 'لینک‌سازی داخلی و خارجی هدفمند', 'بهبود سرعت و Core Web Vitals', 'سئو محلی و گوگل مپ', 'جلسه‌ی استراتژی هر دو هفته'] },
  { id: 'scale', name: 'تسلط', price: 59000000, tag: 'برای رهبری بازار',
    feat: ['همه‌ی امکانات پلن رشد', 'تیم اختصاصی سئو و محتوا', '۲۰ محتوا و طراحی صفحات فرود', 'بهینه‌سازی نرخ تبدیل (CRO)', 'تحلیل رقبا و داشبورد زنده', 'مشاور رشد اختصاصی با پاسخ همان‌روز'] },
];
const TIPS = [
  'عنوان (title) هر صفحه را یکتا بنویس و عبارت اصلی را نزدیک ابتدای آن بگذار؛ بهتر است زیر حدود ۶۰ کاراکتر بماند.',
  'سرعت موبایل مهم‌تر از دسکتاپ است؛ تصاویر را فشرده کن و فرمت‌های سبک مثل WebP را به‌کار ببر.',
  'هر صفحه فقط یک تیتر اصلی (H1) داشته باشد و تیترهای فرعی را با H2 و H3 مرتب کن.',
  'برای تصاویر متن جایگزین (alt) بنویس؛ هم برای دسترس‌پذیری خوب است هم برای سئوی تصاویر.',
  'لینک‌دادن داخلی از مقاله‌های پربازدید به صفحه‌های فروش، به گوگل نشان می‌دهد کدام صفحه‌ها مهم‌اند.',
  'کسب‌وکار محلی؟ پروفایل گوگل مپ را کامل کن: آدرس، ساعت کاری، عکس و پاسخ به نظرها.',
  'توضیح متا (meta description) را مثل یک تبلیغ کوتاه بنویس تا کلیک بیشتر بگیری؛ زیر حدود ۱۶۰ کاراکتر.',
  'صفحه‌های خطای ۴۰۴ و لینک‌های شکسته را مرتب بررسی کن؛ لینک شکسته اعتماد کاربر و گوگل را کم می‌کند.',
  'محتوایی بنویس که به سؤال واقعی مشتری‌هایت جواب بدهد، نه فقط کلمه‌ی کلیدی تکرار کند.',
  'سایتت باید HTTPS داشته باشد و روی موبایل راحت باز شود؛ هر دو سیگنال مهم رتبه‌بندی‌اند.',
];

const mainMenu = () => keyboard([
  [{ text: '🔍 تحلیل رایگان سایت', callback_data: 'analyze' }],
  [{ text: '📦 پلن‌ها و قیمت', callback_data: 'plans' }, { text: '🎁 کد تخفیف', callback_data: 'discount' }],
  [{ text: '💡 نکته‌ی سئو', callback_data: 'tip' }, { text: '🎫 پشتیبانی (تیکت)', callback_data: 'support' }],
  [{ text: '🌐 ورود به سایت رشدینک', url: siteLink('menu') }],
]);
const backRow = [{ text: '🏠 منوی اصلی', callback_data: 'menu' }];

const WELCOME = (name) =>
  `سلام${name ? ' ' + name : ''} 👋\nبه ربات رشدینک خوش اومدی.\n\n` +
  'رشدینک به صاحبان کسب‌وکار کمک می‌کند در گوگل بهتر دیده شوند.\n' +
  'اینجا می‌توانی:\n• سایتت را رایگان تحلیل کنی (سرعت و سئو)\n• پلن‌ها و قیمت‌ها را ببینی\n• کد تخفیف فعال را بگیری\n• سؤالت را با پشتیبانی (تیکت) در میان بگذاری\n\nیکی را انتخاب کن 👇';

/* ---------- وضعیت گفتگو (در حافظه) ---------- */
const state = new Map();            // chatId -> 'analyze' | 'ticket' | 'tkr:<id>'
const rate = new Map();             // chatId -> [timestamps]
const pendingBroadcast = new Map(); // adminId -> { text, seg }
const adminAwait = new Map();       // adminId -> کلید گروهی که مدیر قرار است برایش پیام بنویسد

function allowAnalyze(chatId) {
  const now = Date.now(), list = (rate.get(chatId) || []).filter(t => now - t < 3600e3);
  if (list.length >= ANALYZE_LIMIT_PER_HOUR) { rate.set(chatId, list); return false; }
  list.push(now); rate.set(chatId, list); return true;
}

/* ---------- دستورها ---------- */
async function showMenu(chatId, name) { state.delete(chatId); return send(chatId, WELCOME(name), mainMenu()); }

async function showPlans(chatId) {
  const text = PLANS.map(p =>
    `📦 پلن ${p.name} — ${p.tag}\n💰 ${fmt(p.price)} تومان در ماه\n` + p.feat.map(f => '• ' + f).join('\n')
  ).join('\n\n──────────\n\n') + '\n\n✨ پرداخت سه‌ماهه ۱۵٪ تخفیف دارد.';
  return send(chatId, text, keyboard([[{ text: '🛒 خرید و جزئیات در سایت', url: siteLink('plans') + '#plans' }], backRow]));
}

async function showDiscount(chatId) {
  let d = null, personal = false;
  if (pool) { try { const u = (await pool.query('SELECT fu_code FROM bale_users WHERE chat_id=$1', [chatId])).rows[0]; if (u?.fu_code) { const c = (await pool.query('SELECT code, percent, plan_id, expires_at FROM discounts WHERE code=$1 AND active=true AND expires_at > now() AND (max_uses IS NULL OR used_count < max_uses)', [u.fu_code])).rows[0]; if (c) { d = c; personal = true; } } } catch {} }
  if (!d) try { const r = await fetch(`${API_BASE}/api/discounts/active`, { signal: AbortSignal.timeout(15000) }); d = r.ok ? await r.json() : null; } catch {}
  if (!d) return send(chatId, 'در حال حاضر کد تخفیف فعالی نداریم. 🙏\nولی تحلیل سایتت همیشه رایگان است.', keyboard([[{ text: '🔍 تحلیل رایگان سایت', callback_data: 'analyze' }], backRow]));
  const left = Math.max(0, new Date(d.expires_at) - Date.now());
  const days = Math.floor(left / 86400e3), hours = Math.floor((left % 86400e3) / 3600e3);
  const plan = d.plan_id ? (PLANS.find(p => p.id === d.plan_id) || {}).name : null;
  return send(chatId,
    `🎁 ${personal ? 'کد تخفیف اختصاصی تو' : 'کد تخفیف فعال'}\n\nکد: ${d.code}\nتخفیف: ${faDigits(d.percent)}٪${plan ? ' (فقط پلن ' + plan + ')' : ''}\n⏳ مهلت: ${faDigits(days)} روز و ${faDigits(hours)} ساعت\n\nروی دکمه‌ی زیر بزن؛ تخفیف خودکار روی سایت اعمال می‌شود.`,
    keyboard([[{ text: '🛒 رفتن به سایت با تخفیف', url: siteLink('discount') + (personal ? '&code=' + d.code : '') + '#plans' }], backRow]));
}

async function showTip(chatId) {
  const tip = TIPS[Math.floor(Math.random() * TIPS.length)];
  return send(chatId, `💡 نکته‌ی سئو\n\n${tip}`, keyboard([[{ text: '💡 یک نکته‌ی دیگر', callback_data: 'tip' }, { text: '🔍 تحلیل سایتم', callback_data: 'analyze' }], backRow]));
}

async function askAnalyze(chatId) {
  state.set(chatId, 'analyze');
  return send(chatId, 'آدرس سایتت را بفرست 🔍\nمثلاً: example.com', keyboard([backRow]));
}
async function askContact(chatId) {
  state.set(chatId, 'contact');
  return send(chatId, 'برای مشاوره‌ی رایگان، شماره‌ی موبایلت را بفرست (مثلاً 09123456789).\nهمکارانم باهات تماس می‌گیرند.', keyboard([backRow]));
}

const scoreIcon = n => (n == null ? '⚪' : n >= 90 ? '🟢' : n >= 50 ? '🟠' : '🔴');
const sc = n => (n == null ? '—' : faDigits(n));

function extractHost(text) {
  const m = String(text).trim().match(/(?:https?:\/\/)?(?:www\.)?([a-z0-9؀-ۿ-]+(?:\.[a-z0-9؀-ۿ-]+)+)/i);
  return m ? m[1].replace(/[),.،]+$/, '').toLowerCase() : null;
}

async function runAnalyze(chatId, text) {
  const host = extractHost(text);
  if (!host) return send(chatId, 'آدرس معتبر نبود 🤔\nمثلاً این‌طوری بفرست: example.com', keyboard([backRow]));
  if (!allowAnalyze(chatId)) {
    state.delete(chatId);
    return send(chatId, `برای جلوگیری از فشار روی سرویس، هر نفر در هر ساعت حداکثر ${faDigits(ANALYZE_LIMIT_PER_HOUR)} تحلیل می‌تواند بگیرد. کمی بعد دوباره امتحان کن 🙏`, keyboard([[{ text: '🌐 تحلیل در سایت', url: siteLink('limit') }], backRow]));
  }
  state.delete(chatId);
  await send(chatId, `⏳ دارم ${host} را بررسی می‌کنم…\nمعمولاً تا یک دقیقه طول می‌کشد.`);
  try {
    const r = await fetch(`${API_BASE}/api/analyze`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ domain: host }), signal: AbortSignal.timeout(150000),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || `status ${r.status}`);
    const m = data.mobile || {}, d = data.desktop || {}, ms = m.scores || {}, ds = d.scores || {}, v = m.vitals || {};
    const vals = [ms.performance, ms.accessibility, ms.bestPractices, ms.seo].filter(x => typeof x === 'number');
    const overall = vals.length ? Math.round(vals.reduce((a, b) => a + b, 0) / vals.length) : null;
    const rec = overall == null ? PLANS[1] : overall < 45 ? PLANS[2] : overall < 68 ? PLANS[1] : PLANS[0];
    const issues = (m.topIssues || []).slice(0, 3).map(i => '• ' + i.title).join('\n');
    const out =
      `📊 نتیجه‌ی تحلیل ${data.host || host}\n\n` +
      `📱 موبایل\n${scoreIcon(ms.performance)} سرعت: ${sc(ms.performance)}\n${scoreIcon(ms.seo)} سئو: ${sc(ms.seo)}\n${scoreIcon(ms.bestPractices)} بهترین‌شیوه‌ها: ${sc(ms.bestPractices)}\n${scoreIcon(ms.accessibility)} دسترس‌پذیری: ${sc(ms.accessibility)}\n\n` +
      `💻 دسکتاپ\n${scoreIcon(ds.performance)} سرعت: ${sc(ds.performance)}   ${scoreIcon(ds.seo)} سئو: ${sc(ds.seo)}\n\n` +
      (v.lcp ? `⚡ LCP: ${faDigits(v.lcp)}   FCP: ${faDigits(v.fcp || '—')}\n\n` : '') +
      (issues ? `🔧 مهم‌ترین موارد برای بهبود:\n${issues}\n\n` : '') +
      `✅ پلن پیشنهادی ما: ${rec.name}`;
    await countAnalysis(chatId);
    funnelAnalyzed(chatId, data.host || host, overall, (m.topIssues || [])[0]?.title, rec.id).catch(() => {});
    return send(chatId, out, keyboard([
      [{ text: '📦 دیدن پلن‌ها', callback_data: 'plans' }, { text: '🎫 پشتیبانی (تیکت)', callback_data: 'support' }],
      [{ text: '🌐 گزارش کامل در سایت', url: siteLink('analysis') }], backRow]));
  } catch (e) {
    log('analyze failed', host, e.message);
    return send(chatId, 'تحلیل این سایت الان انجام نشد 😕\nممکن است سایت در دسترس نباشد یا سرویس گوگل پاسخ ندهد. کمی بعد دوباره امتحان کن.', keyboard([[{ text: '🌐 تحلیل در سایت', url: siteLink('fail') }], backRow]));
  }
}

async function handleContact(chatId, from, text) {
  const digits = String(text).replace(/[۰-۹]/g, c => String(c.charCodeAt(0) - 0x06f0)).replace(/[٠-٩]/g, c => String(c.charCodeAt(0) - 0x0660)).replace(/\D/g, '');
  const phone = digits.startsWith('98') ? '0' + digits.slice(2) : digits;
  if (!/^09\d{9}$/.test(phone)) return send(chatId, 'شماره معتبر نبود 🤔\nمثلاً: 09123456789', keyboard([backRow]));
  state.delete(chatId);
  await addLead(chatId, phone, from && (from.username ? '@' + from.username : from.first_name));
  for (const a of ADMIN_IDS) send(a, `📞 درخواست مشاوره‌ی جدید\nشماره: ${phone}\nکاربر: ${from?.first_name || ''} ${from?.username ? '@' + from.username : ''}\nشناسه: ${chatId}`);
  return send(chatId, '✅ درخواستت ثبت شد. به‌زودی باهات تماس می‌گیریم.\nتا اون موقع می‌توانی سایتت را رایگان تحلیل کنی.', keyboard([[{ text: '🔍 تحلیل رایگان سایت', callback_data: 'analyze' }], backRow]));
}

/* ---------- پشتیبانی به‌صورت تیکت ---------- */
const TK_STATUS = { open: '🟡 در انتظار پاسخ', answered: '🟢 پاسخ داده شد', closed: '⚪ بسته' };
const ticketAwait = new Map();       // adminId -> شناسه‌ی تیکتی که مدیر در حال نوشتن پاسخش است
const tkRate = new Map();
mem.tickets = []; mem.tseq = 0;
function allowTicket(chatId) {
  const now = Date.now(), list = (tkRate.get(chatId) || []).filter(t => now - t < 3600e3);
  if (list.length >= 10) { tkRate.set(chatId, list); return false; }
  list.push(now); tkRate.set(chatId, list); return true;
}
async function tkCreate(chatId, from, text) {
  const name = from ? ((from.first_name || '') + (from.username ? ' @' + from.username : '')).trim().slice(0, 200) : '';
  if (!pool) { const t = { id: ++mem.tseq, chat_id: chatId, name, status: 'open', created_at: new Date(), msgs: [{ sender: 'user', body: text, created_at: new Date() }] }; mem.tickets.push(t); return t; }
  const t = (await pool.query('INSERT INTO bale_tickets(chat_id, name) VALUES($1,$2) RETURNING *', [chatId, name])).rows[0];
  await pool.query("INSERT INTO bale_ticket_msgs(ticket_id, sender, body) VALUES($1,'user',$2)", [t.id, text]);
  return t;
}
async function tkAdd(id, sender, text) {          // پیام جدید؛ وضعیت را هم به‌روز می‌کند
  const status = sender === 'admin' ? 'answered' : 'open';
  if (!pool) { const t = mem.tickets.find(x => x.id === id); if (!t) return null; t.msgs.push({ sender, body: text, created_at: new Date() }); t.status = status; return t; }
  const r = await pool.query('UPDATE bale_tickets SET status=$2, updated_at=now() WHERE id=$1 RETURNING *', [id, status]);
  if (!r.rows[0]) return null;
  await pool.query('INSERT INTO bale_ticket_msgs(ticket_id, sender, body) VALUES($1,$2,$3)', [id, sender, text]);
  return r.rows[0];
}
async function tkGet(id) {
  if (!pool) { const t = mem.tickets.find(x => x.id === id); return t ? { t, msgs: t.msgs } : null; }
  const t = (await pool.query('SELECT * FROM bale_tickets WHERE id=$1', [id])).rows[0]; if (!t) return null;
  const msgs = (await pool.query('SELECT sender, body, created_at FROM bale_ticket_msgs WHERE ticket_id=$1 ORDER BY id', [id])).rows;
  return { t, msgs };
}
async function tkList(chatId, onlyOpen) {
  if (!pool) return mem.tickets.filter(t => (chatId == null || t.chat_id === chatId) && (!onlyOpen || t.status === 'open')).slice(-15).reverse();
  return (await pool.query(`SELECT * FROM bale_tickets WHERE ($1::bigint IS NULL OR chat_id=$1) AND (NOT $2::boolean OR status='open') ORDER BY updated_at DESC LIMIT 15`, [chatId, !!onlyOpen])).rows;
}
async function tkClose(id) {
  if (!pool) { const t = mem.tickets.find(x => x.id === id); if (t) t.status = 'closed'; return !!t; }
  return (await pool.query("UPDATE bale_tickets SET status='closed', updated_at=now() WHERE id=$1 RETURNING id", [id])).rows.length > 0;
}
async function tkOpenCount() { return (await tkList(null, true)).length; }

async function askSupport(chatId) {
  state.set(chatId, 'ticket');
  return send(chatId, '🎫 پشتیبانی رشدینک\n\nسؤال یا مشکلت را در یک پیام بنویس و بفرست. تیم پشتیبانی بررسی می‌کند و پاسخ را همین‌جا برایت می‌فرستد.\n\n(فعلاً فقط پیام متنی ثبت می‌شود.)', keyboard([[{ text: '📂 تیکت‌های من', callback_data: 'mytickets' }], backRow]));
}
async function handleTicketText(chatId, from, text, ticketId) {
  text = String(text || '').trim().slice(0, 2000);
  if (text.length < 5) return send(chatId, 'پیامت خیلی کوتاه است 🤔 لطفاً سؤالت را کمی کامل‌تر بنویس.', keyboard([backRow]));
  if (!allowTicket(chatId)) { state.delete(chatId); return send(chatId, 'تعداد پیام‌هایت در این ساعت زیاد شد. کمی بعد دوباره بفرست 🙏', keyboard([backRow])); }
  let t;
  if (ticketId) {
    const cur = await tkGet(ticketId);
    if (!cur || String(cur.t.chat_id) !== String(chatId)) { state.delete(chatId); return send(chatId, 'این تیکت پیدا نشد.', keyboard([backRow])); }
    t = await tkAdd(ticketId, 'user', text);
  } else t = await tkCreate(chatId, from, text);
  state.delete(chatId);
  const who = `${from?.first_name || ''} ${from?.username ? '@' + from.username : ''}`.trim();
  for (const a of ADMIN_IDS) send(a, `🎫 ${ticketId ? 'پیام جدید در تیکت' : 'تیکت جدید'} #${faDigits(t.id)}\nاز: ${who || chatId} (شناسه ${chatId})\n\n${text}`, keyboard([[{ text: '💬 پاسخ', callback_data: 'ta:' + t.id }, { text: '✅ بستن', callback_data: 'tc:' + t.id }]]));
  if (!ADMIN_IDS.length) log('ticket without admins', t.id);
  return send(chatId, `✅ ${ticketId ? 'پیامت به تیکت' : 'تیکتت با شماره'} #${faDigits(t.id)} ثبت شد.\nپاسخ را همین‌جا برایت می‌فرستیم.`, keyboard([[{ text: '📂 تیکت‌های من', callback_data: 'mytickets' }], backRow]));
}
function tkRows(list) { return list.map(t => [{ text: `#${t.id} ${TK_STATUS[t.status] || t.status}`, callback_data: 'tv:' + t.id }]); }
async function showMyTickets(chatId) {
  const list = await tkList(chatId, false);
  if (!list.length) return send(chatId, 'هنوز تیکتی نداری.', keyboard([[{ text: '🎫 ثبت تیکت جدید', callback_data: 'support' }], backRow]));
  return send(chatId, '📂 تیکت‌های من\nروی هر تیکت بزن تا گفتگو را ببینی:', keyboard([...tkRows(list), [{ text: '🎫 تیکت جدید', callback_data: 'support' }], backRow]));
}
async function viewTicket(chatId, id, admin) {
  const g = await tkGet(id);
  if (!g || (!admin && String(g.t.chat_id) !== String(chatId))) return send(chatId, 'تیکت پیدا نشد.', keyboard([backRow]));
  let body = g.msgs.map(m => `${m.sender === 'admin' ? '🛠 پشتیبان' : '👤 ' + (admin ? (g.t.name || 'کاربر') : 'من')}:\n${m.body}`).join('\n\n— — —\n\n');
  if (body.length > 3200) body = '…\n' + body.slice(-3200);
  const btn = g.t.status === 'closed' ? [] : admin
    ? [[{ text: '💬 پاسخ', callback_data: 'ta:' + id }, { text: '✅ بستن', callback_data: 'tc:' + id }]]
    : [[{ text: '✍️ ارسال پیام جدید', callback_data: 'tr:' + id }, { text: '✅ بستن تیکت', callback_data: 'tc:' + id }]];
  return send(chatId, `🎫 تیکت #${faDigits(id)} — ${TK_STATUS[g.t.status] || g.t.status}${admin ? `\nکاربر: ${g.t.name || ''} (${g.t.chat_id})` : ''}\n\n${body}`, keyboard([...btn, admin ? [{ text: '📋 تیکت‌های باز', callback_data: 'tl' }] : [{ text: '📂 تیکت‌های من', callback_data: 'mytickets' }], backRow]));
}
async function replyTicket(adminId, id, text) {
  text = String(text || '').trim().slice(0, 3000);
  const g = await tkGet(id);
  if (!g) return send(adminId, 'تیکت پیدا نشد.');
  if (!text) return send(adminId, 'متن پاسخ خالی است.');
  await tkAdd(id, 'admin', text);
  try {
    await bale('sendMessage', { chat_id: g.t.chat_id, text: `📩 پاسخ پشتیبانی — تیکت #${faDigits(id)}\n\n${text}`, ...keyboard([[{ text: '✍️ ادامه‌ی گفتگو', callback_data: 'tr:' + id }, { text: '✅ بستن تیکت', callback_data: 'tc:' + id }]]) });
  } catch (e) { return send(adminId, `⚠️ پاسخ ذخیره شد ولی به کاربر نرسید (${e.message}). احتمالاً ربات را مسدود کرده است.`); }
  return send(adminId, `✅ پاسخ تیکت #${faDigits(id)} برای کاربر ارسال شد.`);
}
async function adminTickets(chatId) {
  const list = await tkList(null, true);
  if (!list.length) return send(chatId, '✅ تیکت بازی نیست.');
  return send(chatId, `📋 تیکت‌های در انتظار پاسخ (${faDigits(list.length)})`, keyboard(tkRows(list)));
}

/* ---------- قیف فروش: پیگیری خودکار با حداکثر ۳ پیام ---------- */
const FU_ON = !/^(0|off|false|no)$/i.test(process.env.FOLLOWUPS || 'on');
const FU_PERCENT = Number(process.env.FU_PERCENT || 15), FU_CODE_HOURS = Number(process.env.FU_CODE_HOURS || 48);
const tehranHour = () => Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Tehran', hour: '2-digit', hourCycle: 'h23' }).format(new Date()));
const inSendWindow = () => { if (/^(0|off|false|no|any)$/i.test(process.env.FU_WINDOW || '')) return true; const h = tehranHour(); return h >= 9 && h < 22; };   // شب پیام نمی‌فرستیم
const stopRow = [{ text: '🔕 دیگر پیام نفرست', callback_data: 'fu_stop' }];
const planOf = id => PLANS.find(p => p.id === id) || PLANS[1];
const priceAfter = (price, pct) => Math.round((price * (1 - pct / 100)) / 1000) * 1000;
const newCode = () => 'U-' + [...crypto.randomBytes(6)].map(b => 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'[b % 31]).join('');

async function funnelAnalyzed(chatId, host, score, issue, planId) {   // بعد از تحلیل، پیگیری شخصی‌سازی می‌شود
  if (!pool) return;
  await pool.query(`UPDATE bale_users SET fu_host=$2, fu_score=$3, fu_issue=$4, fu_plan=$5,
    fu_next = CASE WHEN fu_stop IS NULL AND fu_stage = 0 THEN now() + interval '2 hours' ELSE fu_next END WHERE chat_id=$1`,
    [chatId, String(host).slice(0, 200), score == null ? null : Math.round(score), issue ? String(issue).slice(0, 160) : null, planId || null]);
}
async function issueCode(u) {
  for (let i = 0; i < 4; i++) {
    const code = newCode();
    try {
      const r = await pool.query("INSERT INTO discounts(code, percent, plan_id, expires_at, max_uses) VALUES($1,$2,NULL, now() + make_interval(hours => $3), 3) RETURNING code, expires_at", [code, FU_PERCENT, FU_CODE_HOURS]);
      return r.rows[0];
    } catch (e) { if (!/duplicate|unique/i.test(e.message)) throw e; }
  }
  throw new Error('could not create a discount code');
}
function followupText(u, stage, codeRow) {
  const name = u.first_name ? u.first_name : 'دوست من', plan = planOf(u.fu_plan), host = u.fu_host;
  const link = code => siteLink('fu' + stage) + (code ? '&code=' + code : '') + '#plans';
  if (stage === 0 && host) {
    return { text: `${name}، یادته ${host} را تحلیل کردی؟\n\nنمره‌ی کلی‌ات ${faDigits(u.fu_score ?? '—')} از ۱۰۰ بود${u.fu_issue ? ' و مهم‌ترین مشکل: «' + u.fu_issue + '»' : ''}.\n\nتا این مشکل‌ها حل نشوند، بخشی از جستجوهای مشتری‌هایت به رقبایت می‌رسد. خبر خوب اینکه بیشترشان قابل‌حل‌اند.\n\n✅ پلن پیشنهادی برای تو: ${plan.name} (${fmt(plan.price)} تومان در ماه)\nسؤالی داری؟ از «🎫 پشتیبانی» تیکت بزن؛ همین‌جا جواب می‌دهیم.`,
      kb: [[{ text: '📦 دیدن پلن‌ها', callback_data: 'plans' }, { text: '🎫 سؤال دارم', callback_data: 'support' }], stopRow] };
  }
  if (stage === 0) {
    return { text: `سلام ${name} 👋\n\n${(u.analyses || 0) > 0 ? 'قبلاً سایتت را تحلیل کرده بودی؛ اگر از آن موقع تغییری داده‌ای، دوباره بررسی کن.' : 'هنوز سایتت را تحلیل نکرده‌ای؛ همین ۶۰ ثانیه نشان می‌دهد چرا مشتری‌های گوگل سمت رقبایت می‌روند.'}\n\n🔍 فقط آدرس سایتت را بفرست و رایگان ببین:\n• نمره‌ی سرعت و سئو (موبایل و دسکتاپ)\n• مهم‌ترین مشکلاتی که باید اول حل شوند\n• پلنی که به وضعیتت می‌خورد`,
      kb: [[{ text: '🔍 تحلیل رایگان سایت', callback_data: 'analyze' }], stopRow] };
  }
  if (stage === 1) {
    const hours = Math.round((new Date(codeRow.expires_at) - Date.now()) / 3600e3);
    return { text: `🎁 ${name}، یک کد تخفیف اختصاصی برایت ساختم\n\nکد: ${codeRow.code}\nتخفیف: ${faDigits(FU_PERCENT)}٪ روی همه‌ی پلن‌ها\n⏳ اعتبار: ${faDigits(hours)} ساعت (فقط برای خودت)\n\nپلن ${plan.name} با این کد: ${fmt(priceAfter(plan.price, FU_PERCENT))} تومان در ماه، به‌جای ${fmt(plan.price)}.\n\nروی دکمه‌ی زیر بزنی تخفیف خودکار روی سایت اعمال می‌شود؛ لازم نیست جایی وارد کنی.`,
      kb: [[{ text: `🛒 خرید با ${faDigits(FU_PERCENT)}٪ تخفیف`, url: link(codeRow.code) }], [{ text: '🎫 قبل از خرید سؤال دارم', callback_data: 'support' }], stopRow] };
  }
  const left = Math.max(1, Math.round((new Date(u.fu_code_exp) - Date.now()) / 3600e3));
  return { text: `⏰ ${name}، کد ${u.fu_code} حدود ${faDigits(left)} ساعت دیگر منقضی می‌شود\n\nبعد از آن نمی‌توانم این قیمت را برایت نگه دارم. اگر هنوز مطمئن نیستی، قبل از پرداخت بپرس: تیکت بزن تا همان روز جواب بدهیم.\n\nاین آخرین پیام من در این باره است.`,
    kb: [[{ text: '🛒 استفاده از کد', url: link(u.fu_code) }], [{ text: '🎫 سؤال دارم', callback_data: 'support' }], stopRow] };
}
async function followupTick() {
  if (!pool || !inSendWindow()) return 0;
  const admins = ADMIN_IDS.filter(x => /^\d+$/.test(x)).map(Number);
  const due = (await pool.query("SELECT * FROM bale_users WHERE fu_stop IS NULL AND fu_next IS NOT NULL AND fu_next <= now() AND NOT (chat_id = ANY($1::bigint[])) ORDER BY fu_next LIMIT 30", [admins])).rows;
  let sent = 0;
  for (const u of due) {
    try {
      if (u.fu_code) {   // کد استفاده شده = خرید انجام شده؛ پیگیری تمام
        const c = (await pool.query('SELECT used_count FROM discounts WHERE code=$1', [u.fu_code])).rows[0];
        if (c && c.used_count > 0) { await pool.query("UPDATE bale_users SET fu_stop='converted' WHERE chat_id=$1", [u.chat_id]); continue; }
      }
      if ((await pool.query("SELECT 1 FROM bale_tickets WHERE chat_id=$1 AND (status<>'closed' OR updated_at > now() - interval '24 hours') LIMIT 1", [u.chat_id])).rows.length) {
        await pool.query("UPDATE bale_users SET fu_next = now() + interval '24 hours' WHERE chat_id=$1", [u.chat_id]); continue;   // گفتگوی انسانی در جریان است
      }
      if (u.fu_stage >= 2 && (!u.fu_code_exp || new Date(u.fu_code_exp) < Date.now())) { await pool.query("UPDATE bale_users SET fu_stop='done' WHERE chat_id=$1", [u.chat_id]); continue; }
      let codeRow = null;
      if (u.fu_stage === 1) { codeRow = await issueCode(u); u.fu_code = codeRow.code; u.fu_code_exp = codeRow.expires_at; }
      const m = followupText(u, u.fu_stage, codeRow);
      try { await bale('sendMessage', { chat_id: u.chat_id, text: m.text, ...keyboard(m.kb) }); }
      catch (e) {
        if (/403|block|forbidden|deactivated|not found|kicked/i.test(e.message)) { await pool.query("UPDATE bale_users SET fu_stop='blocked' WHERE chat_id=$1", [u.chat_id]); continue; }
        await pool.query("UPDATE bale_users SET fu_next = now() + interval '2 hours' WHERE chat_id=$1", [u.chat_id]); log('followup send failed', e.message); continue;
      }
      sent++;
      if (u.fu_stage === 0) await pool.query("UPDATE bale_users SET fu_stage=1, fu_next = now() + interval '22 hours' WHERE chat_id=$1", [u.chat_id]);
      else if (u.fu_stage === 1) await pool.query("UPDATE bale_users SET fu_stage=2, fu_code=$2, fu_code_exp=$3, fu_next = $3::timestamptz - interval '10 hours' WHERE chat_id=$1", [u.chat_id, codeRow.code, codeRow.expires_at]);
      else await pool.query("UPDATE bale_users SET fu_stage=3, fu_stop='done', fu_next=NULL WHERE chat_id=$1", [u.chat_id]);
      await sleep(250);
    } catch (e) { log('followup error', u.chat_id, e.message); await pool.query("UPDATE bale_users SET fu_next = now() + interval '3 hours' WHERE chat_id=$1", [u.chat_id]).catch(() => {}); }
  }
  return sent;
}
const FU_TICK_MS = Number(process.env.FU_TICK_SEC || 300) * 1000;
function followupLoop() { setTimeout(function t() { followupTick().catch(e => log('followup', e.message)).finally(() => setTimeout(t, FU_TICK_MS)); }, Math.min(60e3, FU_TICK_MS)); }
async function funnelStop(chatId) {
  if (pool) await pool.query("UPDATE bale_users SET fu_stop='unsub' WHERE chat_id=$1 AND fu_stop IS NULL", [chatId]).catch(() => {});
  return send(chatId, 'باشه، دیگر پیام تبلیغاتی نمی‌فرستم 🙏\nهر وقت خواستی از منو برگرد؛ تحلیل رایگان و پشتیبانی همیشه هست.', keyboard([backRow]));
}
async function funnelAdmin(chatId) {
  const r = (await pool.query(`SELECT COUNT(*) FILTER (WHERE fu_next IS NOT NULL OR fu_stop IS NOT NULL)::int AS enrolled,
      COUNT(*) FILTER (WHERE fu_stop IS NULL AND fu_next IS NOT NULL)::int AS active,
      COUNT(*) FILTER (WHERE fu_stage >= 1)::int AS m1, COUNT(*) FILTER (WHERE fu_stage >= 2)::int AS m2, COUNT(*) FILTER (WHERE fu_stage >= 3)::int AS m3,
      COUNT(fu_code)::int AS codes,
      COUNT(*) FILTER (WHERE fu_stop='unsub')::int AS unsub, COUNT(*) FILTER (WHERE fu_stop='blocked')::int AS blocked, COUNT(*) FILTER (WHERE fu_stop='converted')::int AS converted
    FROM bale_users`)).rows[0];
  const used = (await pool.query("SELECT COUNT(*)::int AS c FROM bale_users u JOIN discounts d ON d.code = u.fu_code WHERE d.used_count > 0")).rows[0].c;
  return send(chatId, `📣 قیف فروش\n\nوارد قیف شده: ${faDigits(r.enrolled)} (فعال: ${faDigits(r.active)})\nپیام ۱ ارسال‌شده: ${faDigits(r.m1)}\nپیام ۲ (کد تخفیف): ${faDigits(r.m2)}\nپیام ۳ (آخرین فرصت): ${faDigits(r.m3)}\n\n🎁 کد ساخته‌شده: ${faDigits(r.codes)} · استفاده‌شده: ${faDigits(used)}\n🔕 انصراف: ${faDigits(r.unsub)} · مسدود: ${faDigits(r.blocked)} · خرید: ${faDigits(r.converted)}\n\nکاربران قدیمی را با /backfill وارد قیف کن.`);
}
async function funnelBackfill(chatId) {
  const admins = ADMIN_IDS.filter(x => /^\d+$/.test(x)).map(Number);
  const r = await pool.query("UPDATE bale_users SET fu_next = now() + interval '1 hour' + random() * interval '16 hours' WHERE fu_next IS NULL AND fu_stop IS NULL AND NOT (chat_id = ANY($1::bigint[])) RETURNING chat_id", [admins]);
  return send(chatId, `✅ ${faDigits(r.rows.length)} کاربر قدیمی وارد قیف شدند. پیام اول در ساعات مجاز (۹ تا ۲۲) و پراکنده در ۱۷ ساعت آینده ارسال می‌شود.`);
}

/* ---------- بخش مدیر ---------- */
async function adminCommand(chatId, text) {
  const [cmd, ...rest] = text.split(/\s+/); const arg = rest.join(' ').trim();
  if (cmd === '/funnel') return pool ? funnelAdmin(chatId) : send(chatId, 'برای قیف فروش دیتابیس لازم است.');
  if (cmd === '/backfill') return pool ? funnelBackfill(chatId) : send(chatId, 'برای قیف فروش دیتابیس لازم است.');
  if (cmd === '/tickets') return adminTickets(chatId);
  if (cmd === '/ticket') return /^\d+$/.test(arg) ? viewTicket(chatId, Number(arg), true) : send(chatId, 'نمونه: /ticket 12');
  if (cmd === '/reply') { const m = arg.match(/^(\d+)\s+([\s\S]+)/); return m ? replyTicket(chatId, Number(m[1]), m[2]) : send(chatId, 'نمونه: /reply 12 متن پاسخ'); }
  if (cmd === '/close') { if (!/^\d+$/.test(arg)) return send(chatId, 'نمونه: /close 12'); return send(chatId, (await tkClose(Number(arg))) ? `تیکت #${faDigits(arg)} بسته شد.` : 'تیکت پیدا نشد.'); }
  if (cmd === '/stats') {
    const s = await stats();
    const src = Object.entries(s.sources).map(([k, v]) => `  ${k}: ${faDigits(v)}`).join('\n');
    return send(chatId, `📈 آمار ربات\nکاربران: ${faDigits(s.users)}\nتحلیل‌ها: ${faDigits(s.analyses)}\nدرخواست مشاوره: ${faDigits(s.leads)}\nتیکت‌های باز: ${faDigits(await tkOpenCount())}` + (src ? `\n\nمنبع ورود:\n${src}` : ''));
  }
  if (cmd === '/dashboard') return dashboardView(chatId);
  if (cmd === '/leads') {
    const l = await lastLeads();
    return send(chatId, l.length ? '📞 آخرین درخواست‌ها\n\n' + l.map(x => `${x.phone} — ${x.note || x.chat_id}`).join('\n') : 'هنوز درخواستی ثبت نشده.');
  }
  if (cmd === '/broadcast') {
    if (!arg) return send(chatId, 'بعد از دستور، متن تبلیغ را بنویس.\nمثال:\n/broadcast تحلیل رایگان سئوی سایتت: roshdink.ir');
    pendingBroadcast.set(String(chatId), { text: arg, seg: 'all' });
    const n = (await allUserIds()).length;
    return send(chatId, `پیش‌نمایش پیام (برای ${faDigits(n)} نفر):\n\n${arg}`, keyboard([[{ text: '✅ ارسال برای همه', callback_data: 'bc_yes' }, { text: '✖️ لغو', callback_data: 'bc_no' }]]));
  }
  return false;
}
async function dashboardView(chatId) {
  const [d, c] = await Promise.all([dashboard(), segCounts()]);
  const src = Object.entries(d.sources).map(([k, v]) => `  ${k}: ${faDigits(v)}`).join('\n');
  const days = (d.days || []).map(x => `  ${x.day}: ${faDigits(x.c)}`).join('\n');
  const text = `📊 داشبورد ربات\n\n👥 کل کاربران: ${faDigits(c.all)}\n🆕 امروز: ${faDigits(c.today)}\n🗓 ۷ روز اخیر: ${faDigits(c.week)}\n📆 ۳۰ روز اخیر: ${faDigits(c.month)}\n🟢 فعال ۲۴ ساعت: ${faDigits(c.act1)}\n🟢 فعال ۷ روز: ${faDigits(c.act7)}\n\n🔍 تحلیل‌ها: ${faDigits(d.analyses)}\n📞 درخواست مشاوره: ${faDigits(d.leads)}`
    + (days ? `\n\nورودی روزانه:\n${days}` : '') + (src ? `\n\nمنبع ورود:\n${src}` : '') + '\n\nیک گروه را انتخاب کن تا کاربرانش را ببینی و بتوانی برایشان پیام بفرستی 👇';
  const b = k => ({ text: `${SEGMENTS[k].label} (${faDigits(c[k] || 0)})`, callback_data: `seg:${k}:0` });
  return send(chatId, text, keyboard([[b('all'), b('today')], [b('week'), b('month')], [b('act1'), b('act7')], [b('leads'), b('analyzed')]]));
}
async function segView(chatId, key, page) {
  const seg = SEGMENTS[key]; if (!seg) return;
  const PER = 15, c = await segCounts(), total = c[key] || 0, pages = Math.max(1, Math.ceil(total / PER));
  page = Math.min(Math.max(0, page), pages - 1);
  const rows = await segUsers(key, page, PER);
  const fmt = t => { try { return new Date(t).toLocaleString('fa-IR', { timeZone: 'Asia/Tehran', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }); } catch { return ''; } };
  const lines = rows.map((u, i) => `${faDigits(page * PER + i + 1)}. ${u.first_name || '—'}${u.username ? ' @' + u.username : ''} · ${fmt(u.created_at)}${u.source ? ' · ' + u.source : ''}`);
  const nav = [];
  if (page > 0) nav.push({ text: '◀️ قبلی', callback_data: `seg:${key}:${page - 1}` });
  if (page < pages - 1) nav.push({ text: 'بعدی ▶️', callback_data: `seg:${key}:${page + 1}` });
  const kb = [];
  if (nav.length) kb.push(nav);
  if (total) kb.push([{ text: `📢 ارسال پیام به این گروه (${faDigits(total)} نفر)`, callback_data: `sbc:${key}` }]);
  kb.push([{ text: '🔙 داشبورد', callback_data: 'dash' }]);
  return send(chatId, `${seg.label}\nتعداد: ${faDigits(total)} — صفحه ${faDigits(page + 1)} از ${faDigits(pages)}\n\n` + (lines.length ? lines.join('\n') : 'کاربری در این گروه نیست.'), keyboard(kb));
}
async function segBroadcastAsk(chatId, key) {
  const seg = SEGMENTS[key]; if (!seg) return;
  const n = (await segIds(key)).length;
  if (!n) return send(chatId, 'این گروه کاربری ندارد.');
  adminAwait.set(String(chatId), key);
  return send(chatId, `متن پیام را برای «${seg.label}» (${faDigits(n)} نفر) بنویس و بفرست.\nبرای انصراف: /cancel`);
}
async function doBroadcast(adminId) {
  const p = pendingBroadcast.get(String(adminId)); pendingBroadcast.delete(String(adminId));
  const text = p && p.text;
  if (!text) return send(adminId, 'پیامی برای ارسال نیست.');
  const ids = await segIds(p.seg || 'all'); let ok = 0, fail = 0;
  await send(adminId, `⏳ ارسال برای ${faDigits(ids.length)} نفر شروع شد…`);
  for (const id of ids) {
    try { await bale('sendMessage', { chat_id: id, text, ...keyboard([[{ text: '🔍 تحلیل رایگان سایت', callback_data: 'analyze' }, { text: '🌐 سایت', url: siteLink('broadcast') }]]) }); ok++; }
    catch { fail++; }
    await sleep(60); // حدود ۱۵ پیام در ثانیه
  }
  return send(adminId, `✅ تمام شد.\nموفق: ${faDigits(ok)}\nناموفق (مثلاً ربات را مسدود کرده‌اند): ${faDigits(fail)}`);
}

/* ---------- مسیریابی آپدیت‌ها ---------- */
async function onCallback(cb) {
  const chatId = cb.message?.chat?.id || cb.from?.id, data = cb.data;
  bale('answerCallbackQuery', { callback_query_id: cb.id }).catch(() => {});
  await touchUser(cb.from);
  if (isAdmin(cb.from?.id)) {
    if (data === 'dash') return dashboardView(chatId);
    if (data?.startsWith('seg:')) { const [, k, p] = data.split(':'); return segView(chatId, k, parseInt(p, 10) || 0); }
    if (data?.startsWith('sbc:')) return segBroadcastAsk(chatId, data.slice(4));
  }
  if (typeof data === 'string' && /^(ta|tc|tv|tr):\d+$/.test(data)) {
    const [k, sid] = data.split(':'), id = Number(sid), adm = isAdmin(cb.from?.id);
    if (k === 'ta') { if (!adm) return; ticketAwait.set(String(chatId), id); return send(chatId, `✍️ پاسخت را برای تیکت #${faDigits(id)} بنویس و بفرست.\n(برای لغو: /cancel)`); }
    if (k === 'tv') return viewTicket(chatId, id, adm);
    const g = await tkGet(id);
    if (!g || (!adm && String(g.t.chat_id) !== String(chatId))) return send(chatId, 'تیکت پیدا نشد.', keyboard([backRow]));
    if (k === 'tr') { state.set(chatId, 'tkr:' + id); return send(chatId, `✍️ پیام جدیدت را برای تیکت #${faDigits(id)} بنویس:`, keyboard([backRow])); }
    if (k === 'tc') { await tkClose(id); if (String(g.t.chat_id) !== String(chatId)) bale('sendMessage', { chat_id: g.t.chat_id, text: `✅ تیکت #${faDigits(id)} بسته شد. اگر سؤال دیگری داشتی، تیکت جدید ثبت کن.` }).catch(() => {}); return send(chatId, `✅ تیکت #${faDigits(id)} بسته شد.`, keyboard([backRow])); }
  }
  if (data === 'tl' && isAdmin(cb.from?.id)) return adminTickets(chatId);
  switch (data) {
    case 'support': case 'contact': return askSupport(chatId);
    case 'mytickets': return showMyTickets(chatId);
    case 'fu_stop': return funnelStop(chatId);
    case 'menu': return showMenu(chatId, cb.from?.first_name);
    case 'analyze': return askAnalyze(chatId);
    case 'plans': return showPlans(chatId);
    case 'discount': return showDiscount(chatId);
    case 'tip': return showTip(chatId);
    case 'bc_yes': return isAdmin(cb.from?.id) ? doBroadcast(cb.from.id) : null;
    case 'bc_no': pendingBroadcast.delete(String(cb.from?.id)); return send(chatId, 'لغو شد.');
  }
}

async function onMessage(msg) {
  const chatId = msg.chat?.id; if (!chatId || msg.chat.type && msg.chat.type !== 'private') return;
  const text = (msg.text || '').trim();
  if (text.startsWith('/start')) {
    const payload = text.split(/\s+/)[1];
    await touchUser(msg.from, payload ? payload.slice(0, 60) : null);
    return showMenu(chatId, msg.from?.first_name);
  }
  await touchUser(msg.from);
  if (isAdmin(msg.from?.id) && adminAwait.has(String(chatId))) {
    const key = adminAwait.get(String(chatId));
    if (text === '/cancel') { adminAwait.delete(String(chatId)); return send(chatId, 'لغو شد.'); }
    if (text && !text.startsWith('/')) {
      adminAwait.delete(String(chatId));
      pendingBroadcast.set(String(chatId), { text, seg: key });
      const n = (await segIds(key)).length;
      return send(chatId, `پیش‌نمایش پیام (برای ${faDigits(n)} نفر از «${SEGMENTS[key].label}»):\n\n${text}`, keyboard([[{ text: '✅ ارسال', callback_data: 'bc_yes' }, { text: '✖️ لغو', callback_data: 'bc_no' }]]));
    }
  }
  if (isAdmin(msg.from?.id) && ticketAwait.has(String(chatId))) {
    const id = ticketAwait.get(String(chatId));
    if (text === '/cancel') { ticketAwait.delete(String(chatId)); return send(chatId, 'لغو شد.'); }
    if (text && !text.startsWith('/')) { ticketAwait.delete(String(chatId)); return replyTicket(chatId, id, text); }
  }
  if (isAdmin(msg.from?.id) && /^\/(stats|dashboard|leads|broadcast|tickets|ticket|reply|close|funnel|backfill)\b/.test(text)) { if (await adminCommand(chatId, text) !== false) return; }
  if (text === '/menu' || text === '/help') return showMenu(chatId, msg.from?.first_name);
  if (text === '/plans') return showPlans(chatId);
  if (text === '/analyze') return askAnalyze(chatId);
  const st = state.get(chatId);
  if (text === '/support' || text === '/ticket') return askSupport(chatId);
  if (st === 'ticket' || st === 'contact') return handleTicketText(chatId, msg.from, text || msg.caption, null);
  if (typeof st === 'string' && st.startsWith('tkr:')) return handleTicketText(chatId, msg.from, text || msg.caption, Number(st.slice(4)));
  if (st === 'analyze') return runAnalyze(chatId, text);
  if (!text) return;
  if (extractHost(text)) return runAnalyze(chatId, text);   // اگر مستقیم آدرس بفرستد
  return send(chatId, 'از منوی زیر یکی را انتخاب کن 👇', mainMenu());
}

async function handleUpdate(u) {
  try {
    if (u.callback_query) await onCallback(u.callback_query);
    else if (u.message) await onMessage(u.message);
  } catch (e) { log('update error', e.message); }
}

/* ---------- اجرا: وب‌هوک یا polling ---------- */
async function startPolling() {
  await bale('deleteWebhook').catch(() => {});
  log('حالت polling فعال شد');
  let offset = 0;
  for (;;) {
    try {
      const ups = await bale('getUpdates', { offset, timeout: 25 }, 40000);
      for (const u of ups || []) { offset = u.update_id + 1; handleUpdate(u); }
    } catch (e) { log('getUpdates', e.message); await sleep(3000); }
  }
}

async function main() {
  await initStore();
  const server = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === `/webhook/${WEBHOOK_SECRET}`) {
      let body = ''; req.on('data', c => { body += c; if (body.length > 1e6) req.destroy(); });
      req.on('end', () => { res.writeHead(200).end('ok'); try { handleUpdate(JSON.parse(body)); } catch {} });
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' }).end('roshdink bale bot is running');
  });
  server.listen(PORT, () => log(`سرور روی پورت ${PORT}`));
  if (FU_ON && pool) followupLoop();

  const useWebhook = MODE === 'webhook' || (MODE === 'auto' && PUBLIC_URL);
  if (useWebhook) {
    try {
      await bale('setWebhook', { url: `${PUBLIC_URL}/webhook/${WEBHOOK_SECRET}` });
      log('وب‌هوک تنظیم شد');
      return;
    } catch (e) { log('setWebhook ناموفق بود، به polling برمی‌گردم:', e.message); }
  }
  startPolling();
}
main().catch(e => { console.error(e); process.exit(1); });
