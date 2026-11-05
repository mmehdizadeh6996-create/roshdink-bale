/* ربات رشدینک (بله / تلگرام؛ با PLATFORM انتخاب می‌شود) — معرفی، تحلیل رایگان سایت، پلن‌ها، کد تخفیف، مشاوره و ارسال تبلیغات
 * بدون وابستگی اجباری؛ فقط اگر DATABASE_URL بدهی از pg استفاده می‌کند.
 */
const http = require('http');
const crypto = require('crypto');

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
}
async function touchUser(from, source) {
  if (!from) return;
  const id = from.id, name = (from.first_name || '').slice(0, 100), uname = (from.username || '').slice(0, 100);
  if (!pool) {
    const u = mem.users.get(id) || { id, first_name: name, username: uname, source: source || null, created: Date.now() };
    u.last = Date.now(); mem.users.set(id, u); return;
  }
  await pool.query(
    `INSERT INTO bale_users(chat_id, first_name, username, source) VALUES($1,$2,$3,$4)
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
  [{ text: '💡 نکته‌ی سئو', callback_data: 'tip' }, { text: '📞 مشاوره‌ی رایگان', callback_data: 'contact' }],
  [{ text: '🌐 ورود به سایت رشدینک', url: siteLink('menu') }],
]);
const backRow = [{ text: '🏠 منوی اصلی', callback_data: 'menu' }];

const WELCOME = (name) =>
  `سلام${name ? ' ' + name : ''} 👋\nبه ربات رشدینک خوش اومدی.\n\n` +
  'رشدینک به صاحبان کسب‌وکار کمک می‌کند در گوگل بهتر دیده شوند.\n' +
  'اینجا می‌توانی:\n• سایتت را رایگان تحلیل کنی (سرعت و سئو)\n• پلن‌ها و قیمت‌ها را ببینی\n• کد تخفیف فعال را بگیری\n• برای مشاوره‌ی رایگان درخواست بدهی\n\nیکی را انتخاب کن 👇';

/* ---------- وضعیت گفتگو (در حافظه) ---------- */
const state = new Map();            // chatId -> 'analyze' | 'contact'
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
  let d = null;
  try { const r = await fetch(`${API_BASE}/api/discounts/active`, { signal: AbortSignal.timeout(15000) }); d = r.ok ? await r.json() : null; } catch {}
  if (!d) return send(chatId, 'در حال حاضر کد تخفیف فعالی نداریم. 🙏\nولی تحلیل سایتت همیشه رایگان است.', keyboard([[{ text: '🔍 تحلیل رایگان سایت', callback_data: 'analyze' }], backRow]));
  const left = Math.max(0, new Date(d.expires_at) - Date.now());
  const days = Math.floor(left / 86400e3), hours = Math.floor((left % 86400e3) / 3600e3);
  const plan = d.plan_id ? (PLANS.find(p => p.id === d.plan_id) || {}).name : null;
  return send(chatId,
    `🎁 کد تخفیف فعال\n\nکد: ${d.code}\nتخفیف: ${faDigits(d.percent)}٪${plan ? ' (فقط پلن ' + plan + ')' : ''}\n⏳ مهلت: ${faDigits(days)} روز و ${faDigits(hours)} ساعت\n\nموقع پرداخت در سایت، کد را وارد کن.`,
    keyboard([[{ text: '🛒 رفتن به سایت', url: siteLink('discount') + '#plans' }], backRow]));
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
    return send(chatId, out, keyboard([
      [{ text: '📦 دیدن پلن‌ها', callback_data: 'plans' }, { text: '📞 مشاوره‌ی رایگان', callback_data: 'contact' }],
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

/* ---------- بخش مدیر ---------- */
async function adminCommand(chatId, text) {
  const [cmd, ...rest] = text.split(/\s+/); const arg = rest.join(' ').trim();
  if (cmd === '/stats') {
    const s = await stats();
    const src = Object.entries(s.sources).map(([k, v]) => `  ${k}: ${faDigits(v)}`).join('\n');
    return send(chatId, `📈 آمار ربات\nکاربران: ${faDigits(s.users)}\nتحلیل‌ها: ${faDigits(s.analyses)}\nدرخواست مشاوره: ${faDigits(s.leads)}` + (src ? `\n\nمنبع ورود:\n${src}` : ''));
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
  switch (data) {
    case 'menu': return showMenu(chatId, cb.from?.first_name);
    case 'analyze': return askAnalyze(chatId);
    case 'plans': return showPlans(chatId);
    case 'discount': return showDiscount(chatId);
    case 'tip': return showTip(chatId);
    case 'contact': return askContact(chatId);
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
  if (isAdmin(msg.from?.id) && /^\/(stats|dashboard|leads|broadcast)\b/.test(text)) { if (await adminCommand(chatId, text) !== false) return; }
  if (text === '/menu' || text === '/help') return showMenu(chatId, msg.from?.first_name);
  if (text === '/plans') return showPlans(chatId);
  if (text === '/analyze') return askAnalyze(chatId);
  const st = state.get(chatId);
  if (st === 'contact') return handleContact(chatId, msg.from, text);
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
