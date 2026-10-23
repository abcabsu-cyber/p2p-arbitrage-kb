// P2P Study bot — Cloudflare Worker.
// Does: /start welcome, subscriber list, channel-subscription check for the mini app,
// owner-only broadcasts (/post <id>, /broadcast <text>, /stats).
//
// Secrets (Cloudflare dashboard → Worker → Settings → Variables and Secrets):
//   BOT_TOKEN       token from BotFather            (Secret)
//   WEBHOOK_SECRET  any long random string           (Secret)
//   OWNER_ID        your numeric Telegram user id    (Variable)
//   SESSION_SECRET  separate long random string that signs the materials access tokens (Secret); if absent WEBHOOK_SECRET is used
//   SETUP_KEY       separate long random string that opens /setup (Secret); if absent WEBHOOK_SECRET is used
//   PAY_BINDING     optional: "off" turns off the check that a payment notice matches its invoice (emergency switch only)
//   AUTO_REVOKE_ON_REFUND  optional: "1" closes access automatically when a refund is paid (default: only alert the owner)
//   SWEEP_KICK_BATCH / SWEEP_JOIN_BATCH  optional numbers: how many expired members are removed / waiting join requests approved per run (default 8 / 12)
//   NOTIFY_BOT_TOKEN  token of a separate bot for payment alerts (Secret); NOTIFY_CHAT_ID optional, default OWNER_ID
//   PAY2328_PROJECT   project UUID from my.2328.io    (Variable)
//   PAY2328_KEY       API key (not the Payout key) from my.2328.io (Secret)
//   JOIN_URL          invite link of the private channel (with join requests on); shown only to paid users (Variable)
//   PRIVATE_CHANNEL   numeric id of the private channel (e.g. -100123...); the bot must be its admin (invite + ban rights); enables auto-approve of join requests and removal after expiry (Variable)
//   COURSE_CH_ECO / COURSE_CH_STD / COURSE_CH_PRO  numeric ids of the course tier channels (bot = admin with invite + ban rights) (Variables)
//   COURSE_JOIN_ECO / COURSE_JOIN_STD / COURSE_JOIN_PRO  invite links of those channels, join requests ON (Variables)
//   CRYPTOBOT_TOKEN   Crypto Pay API token from @CryptoBot → Crypto Pay (Secret); webhook URL: <worker>/pay/webhook-cryptobot
//   PAY_PROVIDER      optional: "2328" (the default when its keys are set)
//   PAY_AMOUNT / PAY_CURRENCY  optional variables, default 4990 / RUB
//   CONTENT_REPO    private GitHub repo with the materials, e.g. "abcabsu-cyber/p2p-content"  (Variable)
//   GH_TOKEN        fine-grained GitHub token, read-only access to that repo               (Secret)
//   (without these two the materials are read from the public site, as before)
//   Cron Trigger (optional): daily backup of paid users sent to the owner, hourly (0 * * * *) so join requests and expiries are handled on time
// KV namespace binding:  SUBS
// ---------------------------------------------------------------------------------

const CFG = {
  BOT_USERNAME: "ptp_study_bot",
  CHANNEL: "@hanballit_arbitrage",
  CHANNEL_URL: "https://t.me/hanballit_arbitrage",
  APP_URL: "https://abcabsu-cyber.github.io/p2p-arbitrage-kb/",
  APP_ORIGIN: "https://abcabsu-cyber.github.io",
  MENU_BUTTON_TEXT: "Открыть базу",
  WELCOME:
    "Это P2P Study — база знаний по P2P арбитражу.\n\n" +
    "Внутри:\n" +
    "• материалы от самых первых шагов до серьёзного уровня\n" +
    "• разборы, чек-листы и инструкции\n" +
    "• обучение и закрытое сообщество\n\n" +
    "Сейчас мы только начали наполнять библиотеку, впереди много нового. А пока изучайте то, что уже есть:",
  PAY_AMOUNT: "4990",
  // course tiers: price in RUB, rank for "this tier or higher", env names of the tier channel and its invite link
  COURSE: {
    eco: { name: "Базовый", amount: "9990", rank: 1 },
    std: { name: "Премиум", amount: "24990", rank: 2 },
    pro: { name: "VIP", amount: "44990", rank: 3 },
  },
  COURSE_START: Date.UTC(2026, 11, 1), // course channels accept members from this day (same as the private channel)
  PAY_CURRENCY: "RUB",
  PAY_LIFETIME: 3600,                 // invoice lifetime, seconds
  PRIVAT_START: Date.UTC(2026, 11, 1), // access opens 1 December 2026
  PRIVAT_DAYS: 31,
  BTN_OPEN: "Открыть приложение",
  BTN_CHANNEL: "Наш канал",
};

const enc = new TextEncoder();
const CHUNK = 38; // sends per invocation (free plan allows 50 subrequests)

// ---------- helpers ----------
async function hmac(keyBytes, data) {
  const key = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(data)));
}
const hex = (b) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");

export async function verifyInitData(initData, botToken, maxAgeSec = 86400) {
  const p = new URLSearchParams(initData || "");
  const hash = p.get("hash");
  if (!hash) return null;
  p.delete("hash");
  const dcs = [...p.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([k, v]) => `${k}=${v}`).join("\n");
  const secret = await hmac(enc.encode("WebAppData"), botToken);
  if (!safeEq(hex(await hmac(secret, dcs)), hash)) return null;
  const age = Date.now() / 1000 - Number(p.get("auth_date") || 0);
  if (!(age >= 0 && age <= maxAgeSec)) return null;
  try { return JSON.parse(p.get("user")); } catch { return null; }
}

// channel membership for /api/session, remembered briefly (/api/check-sub asks Telegram directly and does not use this cache)
const subCache = new Map();
async function channelState(env, uid) {
  const k = String(uid), now = Date.now(), c = subCache.get(k);
  if (c && now - c.t < (c.v === "yes" ? 60000 : 10000)) return c.v;
  const r = await tg(env, "getChatMember", { chat_id: CFG.CHANNEL, user_id: uid }).catch(() => null);
  const v = r && r.ok ? (["member", "administrator", "creator"].includes(r.result.status) ? "yes" : "no") : "error";
  if (v !== "error") { subCache.set(k, { v, t: now }); if (subCache.size > 2000) subCache.delete(subCache.keys().next().value); }
  return v;
}

let SUBREQ = null;   // while a sweep runs: counts every KV and Telegram call, because one invocation may make only about 50 of them on the Free plan
async function tg(env, method, body) {
  if (SUBREQ) SUBREQ.n++;
  const r = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body || {}),
  });
  return r.json();
}

const esc = (t) => String(t).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
const cors = (origin) => ({
  "access-control-allow-origin": origin === CFG.APP_ORIGIN ? origin : CFG.APP_ORIGIN,
  "access-control-allow-methods": "POST, OPTIONS",
  "access-control-allow-headers": "content-type",
  "access-control-max-age": "86400",   // preflight cache (Chromium caps it at 2 h, Safari at 5 min): fewer round trips per launch
  vary: "origin",
});
const json = (obj, status = 200, extra = {}) =>
  new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", ...extra } });

// ---------- subscribers ----------
const addSub = async (env, id, who) => {   // write only the first time (the free KV plan allows 1000 writes a day)
  const cur = await env.SUBS.getWithMetadata(`u:${id}`);
  const uname = who && who.username ? String(who.username).slice(0, 40) : "";
  const fname = who && who.first_name ? String(who.first_name).slice(0, 40) : "";
  if (cur.value) {
    const m = cur.metadata || {};
    if ((m.u || m.n) || !(uname || fname)) return;   // nothing new to learn
    await env.SUBS.put(`u:${id}`, cur.value, { metadata: { t: m.t || JSON.parse(cur.value).ts || Date.now(), u: uname, n: fname } });   // old record without a name: fill it in once
    return;
  }
  if (await env.SUBS.get(`ban:${id}`)) return;   // excluded users are never re-added
  const t = Date.now();
  await env.SUBS.put(`u:${id}`, JSON.stringify({ ts: t }), { metadata: { t, u: uname, n: fname } });
};
const bannedCache = new Map();
async function isBanned(env, id) {
  const now = Date.now(), c = bannedCache.get(String(id));
  if (c && now - c.t < 60000) return c.v;
  const v = !!(await env.SUBS.get(`ban:${id}`));
  bannedCache.set(String(id), { v, t: now });
  return v;
}
const delSub = (env, id) => env.SUBS.delete(`u:${id}`);

// short rolling log of incoming updates, readable by the owner with /debug
async function dbg(env, entry) {
  try {
    const cur = JSON.parse((await env.SUBS.get("dbg")) || "[]");
    cur.unshift({ t: new Date().toISOString().slice(11, 19), ...entry });
    await env.SUBS.put("dbg", JSON.stringify(cur.slice(0, 8)));
  } catch (e) {}
}


// ---------- payments ----------
const b64 = (str) => { const b = enc.encode(str); let s = ""; for (const x of b) s += String.fromCharCode(x); return btoa(s); };
const getPaid = async (env, uid) => { const r = await env.SUBS.get(`paid:${uid}`); return r ? JSON.parse(r) : null; };
const hasAccess = (p) => !!p && p.until > Date.now();

// ---------- private channel automation (needs PRIVATE_CHANNEL = numeric chat id; bot must be admin with "invite" and "ban" rights) ----------
const privOn = (env) => !!env.PRIVATE_CHANNEL;
// "removed" = taken out of the channel, "absent" = was not in it (nothing to do), "error" = Telegram failed, try again later
async function kickFromPrivate(env, uid) {
  if (!privOn(env) || String(uid) === String(env.OWNER_ID)) return "absent";
  const m = await tg(env, "getChatMember", { chat_id: env.PRIVATE_CHANNEL, user_id: Number(uid) }).catch(() => null);
  if (!(m && m.ok)) return "error";
  if (!["member", "restricted"].includes(m.result.status)) return "absent";   // not in the channel (or admin): nothing to remove
  const b = await tg(env, "banChatMember", { chat_id: env.PRIVATE_CHANNEL, user_id: Number(uid), revoke_messages: false }).catch(() => null);
  if (!(b && b.ok)) return "error";
  await tg(env, "unbanChatMember", { chat_id: env.PRIVATE_CHANNEL, user_id: Number(uid), only_if_banned: true }).catch(() => {});   // ban+unban = removal, the user can come back after renewing
  return "removed";
}
// removes the person from every course tier channel; returns how many removals succeeded
async function kickFromCourseChannels(env, uid) {
  let kicked = 0;
  for (const t of Object.keys(CFG.COURSE)) {
    const ch = env["COURSE_CH_" + t.toUpperCase()]; if (!ch) continue;
    const b = await tg(env, "banChatMember", { chat_id: ch, user_id: Number(uid) }).catch(() => null);
    if (b && b.ok) { kicked++; await tg(env, "unbanChatMember", { chat_id: ch, user_id: Number(uid), only_if_banned: true }).catch(() => {}); }
  }
  return kicked;
}
// manual and automatic revocation share these two
async function revokePrivat(env, uid) {
  const had = !!(await env.SUBS.get(`paid:${uid}`));
  await env.SUBS.delete(`paid:${uid}`);
  await env.SUBS.delete(`lastord:${uid}`);   // otherwise the status check would find the old paid order and grant access again
  const removed = privOn(env) && (await kickFromPrivate(env, uid)) === "removed";
  return { had, removed };
}
async function revokeCourse(env, uid) {
  const had = await getCourse(env, uid);
  await env.SUBS.delete(`course:${uid}`);
  const kicked = await kickFromCourseChannels(env, uid);
  return { had: !!had, kicked };
}
// course tier channels: COURSE_CH_ECO / COURSE_CH_STD / COURSE_CH_PRO (numeric ids), invite links COURSE_JOIN_ECO / _STD / _PRO
const courseChannel = (env, chatId) => Object.keys(CFG.COURSE).find((t) => env["COURSE_CH_" + t.toUpperCase()] && String(env["COURSE_CH_" + t.toUpperCase()]) === String(chatId));
async function handleCourseJoin(env, jr, tier) {
  const uid = jr.from.id, chat = jr.user_chat_id || uid;
  const say = (text) => tg(env, "sendMessage", { chat_id: chat, text }).catch(() => {});
  const c = await getCourse(env, uid);
  if (courseRank(c) < CFG.COURSE[tier].rank || (await isBanned(env, uid))) {
    await tg(env, "declineChatJoinRequest", { chat_id: jr.chat.id, user_id: uid }).catch(() => {});
    await say(`Не нашли оплаты тарифа «${CFG.COURSE[tier].name}» для этого аккаунта. Оплатить обучение можно в приложении, раздел «Обучение». Если вы уже оплатили, напишите нам: @hanballit`);
    return;
  }
  if (Date.now() < CFG.COURSE_START) {
    await env.SUBS.put(`jrc:${uid}:${tier}`, String(jr.chat.id), { expirationTtl: 86400 * 60 });
    await say(`Заявка принята ✅ Канал обучения откроется ${fmtDate(CFG.COURSE_START)}, мы одобрим её автоматически.`);
    return;
  }
  const r = await tg(env, "approveChatJoinRequest", { chat_id: jr.chat.id, user_id: uid });
  if (r && r.ok) await say(`Заявка одобрена, добро пожаловать в канал обучения «${CFG.COURSE[tier].name}»! ✅`);
  else await dbg(env, { join: "COURSE APPROVE FAILED " + String(r && r.description).slice(0, 60), uid });
}
async function handleJoinRequest(env, jr) {
  const ct = courseChannel(env, jr.chat.id);
  if (ct) return handleCourseJoin(env, jr, ct);
  if (!privOn(env) || String(jr.chat.id) !== String(env.PRIVATE_CHANNEL)) return;
  const uid = jr.from.id, chat = jr.user_chat_id || uid;
  const say = (text) => tg(env, "sendMessage", { chat_id: chat, text }).catch(() => {});
  const paid = await getPaid(env, uid);
  if (!hasAccess(paid) || (await isBanned(env, uid))) {
    await tg(env, "declineChatJoinRequest", { chat_id: jr.chat.id, user_id: uid }).catch(() => {});
    await say("Не нашли действующей оплаты для этого аккаунта. Оплатить доступ можно в приложении, раздел «Приват». Если вы уже оплатили, напишите нам: @hanballit");
    return;
  }
  if (Date.now() < CFG.PRIVAT_START) {
    await env.SUBS.put(`jr:${uid}`, String(jr.chat.id), { expirationTtl: 86400 * 60 });   // approved by the cron when access opens
    await say(`Заявка принята ✅ Доступ в закрытый канал откроется ${fmtDate(CFG.PRIVAT_START)}, мы одобрим её автоматически.`);
    return;
  }
  const r = await tg(env, "approveChatJoinRequest", { chat_id: jr.chat.id, user_id: uid });
  if (r && r.ok) { await env.SUBS.delete(`kick:${uid}`).catch(() => {}); await say("Заявка одобрена, добро пожаловать в закрытый канал! ✅"); }
  else await dbg(env, { join: "APPROVE FAILED " + String(r && r.description).slice(0, 60), uid });
}
// one budget for both sweeps (course + private): KV calls count too, and the Free plan allows about 50 calls per invocation
const countedKV = (kv) => {
  const w = (f) => (...a) => { if (SUBREQ) SUBREQ.n++; return kv[f](...a); };
  return { get: w("get"), getWithMetadata: w("getWithMetadata"), put: w("put"), delete: w("delete"), list: w("list") };
};
const roomLeft = (cap) => !SUBREQ || SUBREQ.n < Math.min(cap || SUBREQ.max, SUBREQ.max);   // joins stop earlier (cap 24) so that removals of expired people are never starved
// a join request is removed from the queue only when Telegram has answered it; a temporary failure (429, network) keeps it for the next run
async function finishJoin(env, k, r) {
  if (r && r.ok) { await env.SUBS.delete(k.name); return; }
  const d = String((r && r.description) || "");
  const n = ((k.metadata && k.metadata.n) || 0) + 1;
  if (/ALREADY_PARTICIPANT|HIDE_REQUESTER_MISSING|USER_ID_INVALID/i.test(d) || n >= 12) { await env.SUBS.delete(k.name); return; }   // nothing left to answer, or 12 failed runs in a row
  await env.SUBS.put(k.name, "1", { expirationTtl: 86400 * 60, metadata: { n } });
}
async function courseSweep(env) {
  if (Date.now() < CFG.COURSE_START) return;
  const l = await env.SUBS.list({ prefix: "jrc:", limit: batchOf(env.SWEEP_JOIN_BATCH, 12) });
  for (const k of l.keys) {
    if (!roomLeft(24)) return;
    const [, uid, tier] = k.name.split(":");
    const ch = env["COURSE_CH_" + String(tier).toUpperCase()];
    if (!ch || !tierOf(tier)) { await env.SUBS.delete(k.name); continue; }
    if (courseRank(await getCourse(env, uid)) >= tierOf(tier).rank && !(await isBanned(env, uid))) {
      const r = await tg(env, "approveChatJoinRequest", { chat_id: ch, user_id: Number(uid) }).catch(() => null);
      if (r && r.ok) await tg(env, "sendMessage", { chat_id: Number(uid), text: `Обучение началось! Заявка в канал «${CFG.COURSE[tier].name}» одобрена ✅` }).catch(() => {});
      await finishJoin(env, k, r);
    } else {
      const r = await tg(env, "declineChatJoinRequest", { chat_id: ch, user_id: Number(uid) }).catch(() => null);
      await finishJoin(env, k, r);
    }
  }
}
const batchOf = (v, d) => { const n = Math.floor(Number(v)); return n >= 1 && n <= 500 ? n : d; };
async function privateSweep(env0) {
  SUBREQ = { n: 0, max: 40 };
  try { await privateSweepRun({ ...env0, SUBS: countedKV(env0.SUBS) }); } finally { SUBREQ = null; }
}
async function privateSweepRun(env) {
  await courseSweep(env).catch((e) => console.log("course sweep", e));
  if (!privOn(env)) return;
  const now = Date.now();
  if (now >= CFG.PRIVAT_START) {
    const l = await env.SUBS.list({ prefix: "jr:", limit: batchOf(env.SWEEP_JOIN_BATCH, 12) });
    for (const k of l.keys) {
      if (!roomLeft(24)) break;
      const uid = k.name.slice(3);
      const paid = await getPaid(env, uid);
      let r;
      if (hasAccess(paid) && !(await isBanned(env, uid))) {
        r = await tg(env, "approveChatJoinRequest", { chat_id: env.PRIVATE_CHANNEL, user_id: Number(uid) }).catch(() => null);
        if (r && r.ok) await tg(env, "sendMessage", { chat_id: Number(uid), text: "Доступ открыт! Заявка в закрытый канал одобрена ✅" }).catch(() => {});
      } else {
        r = await tg(env, "declineChatJoinRequest", { chat_id: env.PRIVATE_CHANNEL, user_id: Number(uid) }).catch(() => null);   // no valid payment: do not leave the request hanging
      }
      await finishJoin(env, k, r);
    }
  }
  if (now < CFG.PRIVAT_START) return;   // nobody is removed before the opening day
  const kickBatch = batchOf(env.SWEEP_KICK_BATCH, 8);
  const kicked = new Set();   // who is already handled: one list instead of a read per person (every call counts against the per-run budget)
  for (let kc; ;) { const kl = await env.SUBS.list({ prefix: "kick:", cursor: kc }); kl.keys.forEach((x) => kicked.add(x.name.slice(5))); if (kl.list_complete) break; kc = kl.cursor; }
  let cursor, done = 0, errors = 0;
  scan: do {
    const l = await env.SUBS.list({ prefix: "paid:", cursor });
    for (const k of l.keys) {
      const un = k.metadata && k.metadata.until;
      if (!un || un > now) continue;
      const uid = k.name.slice(5);
      if (kicked.has(uid)) continue;
      if (done >= kickBatch || !roomLeft()) break scan;    // subrequest budget per run; the rest goes on the next run
      done++;
      const res = await kickFromPrivate(env, uid);
      if (res === "error") { errors++; if (errors >= 3) break scan; continue; }   // Telegram failed: no mark, so the next run tries again (3 in a row means a systemic problem: stop early)
      await env.SUBS.put(`kick:${uid}`, res === "removed" ? "1" : "0", { expirationTtl: 86400 * 90 });
      if (res === "removed") await tg(env, "sendMessage", { chat_id: Number(uid), text: "Срок доступа в закрытый канал закончился, мы убрали вас из канала. Продлить можно в приложении, раздел «Приват»: после оплаты снова отправьте заявку на вступление." }).catch(() => {});
    }
    cursor = l.list_complete ? undefined : l.cursor;
  } while (cursor);
  if (errors && !(await env.SUBS.get("sweeperr"))) {   // tell the owner once a day, not every run
    await env.SUBS.put("sweeperr", "1", { expirationTtl: 86400 });
    await notifyOwner(env, "<b>⚠️ Сейчас не удалось проверить или убрать из закрытого канала часть участников с истёкшим сроком.</b>\nПопробую снова на следующем запуске. Если сообщение повторяется, проверьте права бота в канале (приглашение и блокировка участников).");
  }
}
const fmtDate = (ts) => new Date(ts).toLocaleDateString("ru-RU", { day: "numeric", month: "long", year: "numeric", timeZone: "Europe/Moscow" }).replace(/\s?г\.$/, "");

const fmtDT = (ts) => new Date(ts).toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit", timeZone: "Europe/Moscow" }) + " МСК";

// Payment alerts go to a separate bot (NOTIFY_BOT_TOKEN, chat NOTIFY_CHAT_ID or the owner); falls back to the main bot.
async function notifyOwner(env, html) {
  const token = env.NOTIFY_BOT_TOKEN || env.BOT_TOKEN;
  const chat = env.NOTIFY_CHAT_ID || env.OWNER_ID;
  if (!token || !chat) return;
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chat, text: html, parse_mode: "HTML", disable_web_page_preview: true }),
    }).then(async (r) => { if (!r.ok) await dbg(env, { notify: "ALERT SEND FAILED " + r.status }); });
  } catch (e) { await dbg(env, { notify: "ALERT SEND ERROR " + String(e && e.message || e).slice(0, 80) }); }
}
const PAY_WARN = {
  wrong_amount: "⚠️ Оплачено не полностью",
  underpaid: "⚠️ Оплачено не полностью",
  aml_lock: "🚫 Платёж заблокирован проверкой AML. Доступ не выдан",
  wrong_amount_waiting: "⚠️ Оплачено не полностью, ждём доплату",
  system_fail: "❌ Сбой платёжной системы",
  refund_process: "↩️ Возврат в процессе",
  refund_paid: "↩️ Возврат выполнен",
  refund_fail: "❌ Возврат не удался",
};


// ---------- payment providers ----------
const payProvider = (env) => {
  const has2328 = !!(env.PAY2328_PROJECT && env.PAY2328_KEY);
  return has2328 ? "2328" : null;
};
const API2328 = "https://api.2328.io/api";
async function sign2328(bodyStr, key) {
  return hex(await hmac(enc.encode(key), b64(bodyStr)));
}
const safeEq = (a, b) => { a = String(a); b = String(b); if (a.length !== b.length) return false; let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i); return d === 0; };
async function call2328(env, path, obj) {
  const body = JSON.stringify(obj);
  const r = await fetch(API2328 + path, {
    method: "POST",
    headers: { "content-type": "application/json", "user-agent": "P2PStudyBot/1.0 (+https://t.me/ptp_study_bot)", project: env.PAY2328_PROJECT, sign: await sign2328(body, env.PAY2328_KEY) },
    body,
  });
  const j = await r.json().catch(() => ({}));
  return { ok: r.ok && j.state === 0 && !!j.result, j, status: r.status };
}
// what is being bought: the private channel (default) or a course tier
// tariff lookup that ignores inherited names such as "__proto__" or "constructor"
const tierOf = (t) => (typeof t === "string" && Object.prototype.hasOwnProperty.call(CFG.COURSE, t) ? CFG.COURSE[t] : null);
// unique order number: time + random part, so two invoices created in the same millisecond never share an id
function newOrderId(uid) {
  const r = new Uint8Array(6); crypto.getRandomValues(r);
  return `u${uid}-${Date.now().toString(36)}${[...r].map((x) => x.toString(36).padStart(2, "0")).join("")}`.toLowerCase();
}
function offerFor(env, body) {
  const t = body && body.product === "course" ? tierOf(body.tier) : null;
  if (body && body.product === "course" && !t) return null;
  const cur = String(env.PAY_CURRENCY || CFG.PAY_CURRENCY);
  if (t) return { product: "course", tier: body.tier, amount: t.amount, currency: "RUB", desc: `P2P Study: обучение, тариф «${t.name}»` };
  return { product: "privat", amount: String(env.PAY_AMOUNT || CFG.PAY_AMOUNT), currency: cur, desc: "P2P Study: доступ в закрытый канал" };
}
// saved with every order: what was sold and the amount/currency the invoice was created for (checked when the payment notice arrives)
const ordExtra = (o) => ({ ...(o && o.product === "course" ? { product: "course", tier: o.tier } : {}), ...(o && o.amount ? { exp: { a: String(o.amount), c: String(o.currency || "") } } : {}), ...(o && o.n ? { n: o.n } : {}) });
async function createInvoice2328(env, user, offer) {
  offer = offer || offerFor(env, null);
  const order = newOrderId(user.id);
  const r = await call2328(env, "/v1/payment", {
    amount: offer.amount,
    currency: offer.currency,
    order_id: order,
    url_callback: CFG.SELF + "/pay/webhook2328",
    url_success: `https://t.me/${CFG.BOT_USERNAME}`,   // back to Telegram, not the public site
    url_return: `https://t.me/${CFG.BOT_USERNAME}`,
    description: offer.desc,
    ttl_seconds: CFG.PAY_LIFETIME,
  });
  if (!r.ok || !r.j.result.url) return { error: (r.j && (r.j.message || r.j.error)) || "2328 " + r.status };
  await env.SUBS.put(`ord:${order}`, JSON.stringify({ uid: user.id, ts: Date.now(), uuid: r.j.result.uuid, p: "2328", url: r.j.result.url, ...ordExtra(offer), who: { u: user.username || "", n: user.first_name || "" } }), { expirationTtl: 60 * 60 * 24 * 30 });
  await env.SUBS.put(`lastord:${user.id}`, order, { expirationTtl: 60 * 60 * 24 });
  return { url: r.j.result.url, order };
}
// 2328 payload -> the common shape used by processPayment
function norm2328(b) {
  const map = { paid: "paid", overpaid: "paid_over", underpaid: "underpaid", aml_lock: "aml_lock", refund_process: "refund_process", refund_paid: "refund_paid", refund_fail: "refund_fail", wrong_amount: "wrong_amount", wrong_amount_waiting: "wrong_amount_waiting", system_fail: "system_fail" };
  return {
    status: map[b.payment_status] || "ignore:" + b.payment_status,
    order_id: b.order_id, uuid: b.uuid, amount: b.amount, currency: b.currency,
    payment_amount_usd: b.payment_amount_usd, payer_amount: b.payer_amount, payer_currency: b.payer_currency,
    network: b.network, txid: b.txid,
  };
}
async function verify2328(rawText, body, key) {
  const got = String(body.sign || "").toLowerCase();
  if (!got) return false;
  const cands = [];
  const strip = rawText.replace(/,\s*"sign"\s*:\s*"[^"]*"/, "").replace(/"sign"\s*:\s*"[^"]*"\s*,\s*/, "");
  cands.push(strip);   // the raw bytes without the sign field
  const rest = { ...body }; delete rest.sign;
  cands.push(JSON.stringify(rest));
  for (const c of cands) if (safeEq(await sign2328(c, key), got)) return true;
  return false;
}
async function handlePay2328Webhook(env, req) {
  const raw = await req.text();
  if (raw.length > 20000) return new Response("too big", { status: 413 });
  let body; try { body = JSON.parse(raw); } catch { return new Response("bad json", { status: 400 }); }
  if (!body || typeof body !== "object") return new Response("bad json", { status: 400 });
  if (!env.PAY2328_KEY || !(await verify2328(raw, body, env.PAY2328_KEY))) {
    console.log("2328 bad sign");   // no KV write: anyone can send unsigned requests
    return new Response("unauthorized", { status: 401 });
  }
  await dbg(env, { pay: `2328 ${body.payment_status} ${body.order_id}` });
  if (String(body.order_id || "").startsWith("test-")) {   // synthetic event from /test2328: never grants anything
    await notifyOwner(env, `🧪 <b>Тестовый webhook 2328 получен</b>\nПодпись верна ✅\nСтатус: ${esc(body.payment_status)}\nЗаказ: <code>${esc(body.order_id)}</code>\nДоступ не выдавался.`);
    return new Response("ok");
  }
  const n = norm2328(body);
  if (n.status.startsWith("ignore:")) return new Response("ok");
  return processPayment(env, n, n.status);   // propagate 500 so 2328 retries after a failed grant
}
// if a webhook was lost: ask 2328 for the latest order of this user
const RECON = new Map();   // per-user throttle: the app polls /api/status, the provider API is asked at most every 15 s
async function reconcile2328(env, uid) {
  const order = await env.SUBS.get(`lastord:${uid}`);
  if (!order) return;
  const ord = JSON.parse((await env.SUBS.get(`ord:${order}`)) || "null");
  if (ord && ord.p === "cryptobot") return reconcileCryptoBot(env, order, ord);
  if (payProvider(env) !== "2328") return;
  const r = await call2328(env, "/v1/payment/info", { order_id: order });
  if (!r.ok) return;
  const n = norm2328(r.j.result);
  if (n.status === "paid" || n.status === "paid_over") await processPayment(env, n, n.status);
}

// ---------- Crypto Bot (Crypto Pay API) ----------
const CRYPTOBOT_API = "https://pay.crypt.bot/api";
async function callCryptoBot(env, method, params, get) {
  const url = CRYPTOBOT_API + "/" + method + (get ? "?" + new URLSearchParams(params) : "");
  const r = await fetch(url, get ? { headers: { "Crypto-Pay-API-Token": env.CRYPTOBOT_TOKEN } } : {
    method: "POST", headers: { "content-type": "application/json", "Crypto-Pay-API-Token": env.CRYPTOBOT_TOKEN }, body: JSON.stringify(params),
  });
  const j = await r.json().catch(() => ({}));
  return { ok: r.ok && j.ok === true && !!j.result, j, status: r.status };
}
async function createInvoiceCryptoBot(env, user, offer) {
  offer = offer || offerFor(env, null);
  const order = newOrderId(user.id);
  const r = await callCryptoBot(env, "createInvoice", {
    currency_type: "fiat",
    fiat: offer.currency,
    amount: offer.amount,
    description: offer.desc,
    payload: order,
    allow_comments: false,
    allow_anonymous: false,
    expires_in: CFG.PAY_LIFETIME,
    paid_btn_name: "callback",
    paid_btn_url: `https://t.me/${CFG.BOT_USERNAME}`,
  });
  const inv = r.j && r.j.result;
  if (!r.ok || !inv.bot_invoice_url) return { error: (r.j && r.j.error && (r.j.error.name || r.j.error.code)) || "cryptobot " + r.status };
  await env.SUBS.put(`ord:${order}`, JSON.stringify({ uid: user.id, ts: Date.now(), uuid: String(inv.invoice_id), p: "cryptobot", url: inv.bot_invoice_url, tg: true, ...ordExtra(offer), who: { u: user.username || "", n: user.first_name || "" } }), { expirationTtl: 60 * 60 * 24 * 30 });
  await env.SUBS.put(`lastord:${user.id}`, order, { expirationTtl: 60 * 60 * 24 });
  return { url: inv.bot_invoice_url, order, tg: true };
}
function normCryptoBot(inv) {
  return {
    status: inv.status === "paid" ? "paid" : "ignore:" + inv.status,
    order_id: inv.payload, uuid: String(inv.invoice_id),
    amount: inv.amount, currency: inv.fiat || inv.asset || "",
    payment_amount_usd: inv.paid_usd_rate && inv.paid_amount ? (Number(inv.paid_usd_rate) * Number(inv.paid_amount)).toFixed(2) : undefined,
    payer_amount: inv.paid_amount, payer_currency: inv.paid_asset,
    network: "Crypto Bot", commission: inv.fee_amount ? `${inv.fee_amount} ${inv.fee_asset || inv.paid_asset || ""}`.trim() : "",
  };
}
async function handleCryptoBotWebhook(env, req) {
  const raw = await req.text();
  if (raw.length > 20000) return new Response("too big", { status: 413 });
  if (!env.CRYPTOBOT_TOKEN) return new Response("off", { status: 404 });
  const secret = new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(env.CRYPTOBOT_TOKEN)));
  const want = hex(await hmac(secret, raw));
  if (!safeEq(want, String(req.headers.get("crypto-pay-api-signature") || "").toLowerCase())) {
    console.log("cryptobot bad sign");
    return new Response("unauthorized", { status: 401 });
  }
  let body; try { body = JSON.parse(raw); } catch { return new Response("bad json", { status: 400 }); }
  if (!body || typeof body !== "object") return new Response("bad json", { status: 400 });
  { const rd = Number(body.request_date) || Date.parse(body.request_date) / 1000; if (rd && Math.abs(Date.now() / 1000 - rd) > 3600) return new Response("stale", { status: 400 }); }
  if (body.update_type !== "invoice_paid" || !body.payload) return new Response("ok");
  await dbg(env, { pay: `cryptobot ${body.payload.status} ${body.payload.payload}` });
  const n = normCryptoBot(body.payload);
  if (n.status !== "paid") return new Response("ok");
  return processPayment(env, n, "paid");   // propagate 500 so Crypto Bot retries after a failed grant
}
async function reconcileCryptoBot(env, order, ord) {
  if (!env.CRYPTOBOT_TOKEN || !ord || !ord.uuid) return;
  const r = await callCryptoBot(env, "getInvoices", { invoice_ids: ord.uuid }, true);
  const inv = r.ok && r.j.result && r.j.result.items && r.j.result.items[0];
  if (!inv || inv.payload !== order) return;
  const n = normCryptoBot(inv);
  if (n.status === "paid") await processPayment(env, n, "paid");
}

const hasOrder = (rec, order) => !!(rec && order && Array.isArray(rec.orders) && rec.orders.includes(order));
// Idempotent: an order that is already counted is never added twice. KV has no atomic writes, so after writing we read the record back;
// if a concurrent write replaced ours (our order is missing), we add it again on top of the newer record.
async function grantAccess(env, uid, info) {
  let rec, cur;
  for (let i = 0; i < 3; i++) {
    cur = await getPaid(env, uid);
    if (hasOrder(cur, info.order)) return cur;   // this order is already counted (repeated or simultaneous delivery)
    const base = Math.max(Date.now(), CFG.PRIVAT_START, cur && cur.until > Date.now() ? cur.until : 0);
    rec = { until: base + CFG.PRIVAT_DAYS * 86400000, ts: Date.now(), orders: [...((cur && cur.orders) || []), info.order].filter(Boolean), amount: info.amount, currency: info.currency };
    await env.SUBS.put(`paid:${uid}`, JSON.stringify(rec), { metadata: { until: rec.until, ts: rec.ts, amount: rec.amount, currency: rec.currency, n: rec.orders.length } });
    if (hasOrder(await getPaid(env, uid), info.order)) break;
  }
  if (env.PRIVATE_CHANNEL && cur) await env.SUBS.delete(`kick:${uid}`).catch(() => {});   // renewal: the next expiry is handled again
  return rec;
}

const getCourse = async (env, uid) => { const r = await env.SUBS.get(`course:${uid}`); return r ? JSON.parse(r) : null; };
const courseRank = (c) => (c && tierOf(c.tier) ? tierOf(c.tier).rank : 0);
async function grantCourse(env, uid, tier, info) {
  let rec;
  for (let i = 0; i < 3; i++) {
    const cur = await getCourse(env, uid);
    if (hasOrder(cur, info.order)) return cur;   // already counted
    const best = cur && courseRank(cur) >= tierOf(tier).rank ? cur.tier : tier;   // keep the highest tier bought
    rec = { tier: best, tiers: [...new Set([...((cur && cur.tiers) || []), tier])], ts: Date.now(), orders: [...((cur && cur.orders) || []), info.order].filter(Boolean), amount: info.amount, currency: info.currency };
    await env.SUBS.put(`course:${uid}`, JSON.stringify(rec), { metadata: { tier: rec.tier, ts: rec.ts, n: rec.orders.length } });
    if (hasOrder(await getCourse(env, uid), info.order)) break;
  }
  return rec;
}
// "" when the notice fits the order, otherwise a short reason
function orderMismatch(ord, body) {
  if (ord.uuid && body.uuid && String(ord.uuid) !== String(body.uuid)) return "номер счёта в уведомлении отличается от созданного";
  const e = ord.exp;
  if (e && body.currency && String(body.currency).toUpperCase() === String(e.c).toUpperCase()) {
    const paid = Number(body.amount), want = Number(e.a);
    if (Number.isFinite(paid) && Number.isFinite(want) && paid + 0.005 < want) return `сумма ${body.amount} ${body.currency} меньше заказанной ${e.a}`;
  }
  return "";
}

async function processPayment(env, body, status) {
  try { return await processPaymentInner(env, body, status); }
  catch (e) {
    await dbg(env, { pay: "PROCESS ERROR " + String(e && e.message || e).slice(0, 80), order: String(body && body.order_id || "") });
    await notifyOwner(env, `<b>❗ Ошибка обработки платежа</b>\nЗаказ: <code>${esc(body && body.order_id || "")}</code>\n${esc(String(e && e.message || e).slice(0, 200))}\nПровайдер повторит уведомление; если доступ не выдан, проверьте вручную.`);
    return new Response("error", { status: 500 });
  }
}
async function processPaymentInner(env, body, status) {
  const crypt = [body.payer_amount && `${body.payer_amount} ${body.payer_currency || ""}`.trim(), body.network && `сеть ${body.network}`].filter(Boolean).join(", ");
  const SYM = { RUB: "₽", USD: "$", EUR: "€", USDT: "USDT" };
  const sumTxt = `<b>${esc(String(body.amount).replace(/\.0+$/, ""))}${SYM[body.currency] ? " " + SYM[body.currency] : " " + esc(body.currency || "")}</b>${body.payment_amount_usd ? ` (≈ ${esc(body.payment_amount_usd)} $)` : ""}`;
  const whoBlock = async (uid) => {
    let m = uid ? (await env.SUBS.getWithMetadata(`u:${uid}`)).metadata || {} : {};
    if (!(m.u || m.n) && ordKV && ordKV.who) m = ordKV.who;   // name saved with the order when the subscriber record has none
    return [
      `👤 ID: ${uid ? `<code>${uid}</code>` : "неизвестен"}`,
      `👤 Username: ${m.u ? "@" + esc(m.u) : "—"}`,
      m.n ? `📛 Имя: ${esc(m.n)}` : "",
    ].filter(Boolean).join("\n");
  };
  const details = (who) => [
    who,
    `💳 Сумма: ${sumTxt}`,
    isCourse ? `🔖 Тариф: Обучение · ${esc(courseName)}` : `🔖 Тариф: Приват`,
    isCourse ? `📅 Доступ: навсегда + приват на ${CFG.PRIVAT_DAYS} дн.` : `📅 Дней: ${CFG.PRIVAT_DAYS}`,
    crypt && `💱 Оплачено: ${esc(crypt)}`,
    body.commission ? `🏦 Комиссия сервиса: ${esc(body.commission)}` : "",
    `🕒 Время: ${fmtDT(Date.now())}`,
    `🧾 Заказ: <code>${esc(body.order_id)}</code>`,
    `ℹ️ Payment ID: <code>${esc(body.uuid || "")}</code>`,
    body.txid ? `🔗 TXID: <code>${esc(body.txid)}</code>` : "",
  ].filter(Boolean).join("\n");
  const ordKV = JSON.parse((await env.SUBS.get(`ord:${body.order_id}`)) || "null");
  const uid0 = ordKV ? ordKV.uid : Number(body.additional_data);
  var isCourse = !!(ordKV && ordKV.product === "course" && tierOf(ordKV.tier));
  var courseName = isCourse ? tierOf(ordKV.tier).name : "";

  if (PAY_WARN[status]) {
    let extra = "";
    if (status === "aml_lock") {
      extra = `\n\nЧто делать: напишите в чат поддержки 2328 (t.me/sup2328):\n<code>Прошу проверить AML-кейс. Проект P2P Study. Payment ID: ${esc(body.uuid || "")}, TXID: ${esc(body.txid || "")}, заказ: ${esc(body.order_id)}.</code>\nОни решают в среднем за 20 минут, максимум за 8 часов: пропускают платёж (тогда доступ выдастся сам) или возвращают деньги плательщику.`;
      if (uid0 && !(await env.SUBS.get(`aml:${body.order_id}`))) {   // tell the payer once per order
        await env.SUBS.put(`aml:${body.order_id}`, "1", { expirationTtl: 86400 * 3 });
        await tg(env, "sendMessage", { chat_id: uid0, text: "Ваш платёж находится на проверке у платёжного сервиса ⏳\n\nОбычно это занимает около 20 минут, максимум 8 часов. Если платёж пропустят, доступ откроется автоматически и мы напишем вам. Если нет, деньги вернутся на ваш адрес отправителя. Вопросы можно задать нам: @hanballit" }).catch(() => {});
      }
    }
    if (status === "refund_paid" && uid0) {
      const cmd = isCourse ? `/revokecourse ${uid0}` : `/revoke ${uid0}`;
      const pr = await getPaid(env, uid0), cr = isCourse ? await getCourse(env, uid0) : null;
      // automatic revocation only when this is the person's single paid order, so other purchases are never touched
      const single = isCourse
        ? hasOrder(cr, body.order_id) && cr.orders.length === 1 && (!pr || (pr.orders || []).every((o) => o === "bonus:" + body.order_id))
        : hasOrder(pr, body.order_id) && pr.orders.length === 1;
      if (env.AUTO_REVOKE_ON_REFUND === "1" && single) {
        if (isCourse) { await revokeCourse(env, uid0); await revokePrivat(env, uid0); } else await revokePrivat(env, uid0);
        extra = `\n\n✅ Доступ закрыт автоматически (AUTO_REVOKE_ON_REFUND). Вернуть: ${isCourse ? "/grantcourse " + uid0 + " " + ordKV.tier : "/grant " + uid0}`;
      } else {
        extra = `\n\nДоступ остаётся. Если возврат полный, закройте вручную: <code>${cmd}</code>${isCourse ? `\nи бонус-приват: <code>/revoke ${uid0}</code>` : ""}${single ? "" : "\nУ человека есть и другие оплаты: проверьте, что именно возвращено."}`;
      }
    }
    if (uid0 && ["underpaid", "wrong_amount", "wrong_amount_waiting", "system_fail"].includes(status) && !(await env.SUBS.get(`pw:${body.order_id}`))) {
      await env.SUBS.put(`pw:${body.order_id}`, "1", { expirationTtl: 86400 * 3 });   // tell the payer once per order
      const txt = status === "system_fail"
        ? `Возникла ошибка у платёжного сервиса при обработке вашего платежа (заказ ${body.order_id}). Деньги не потеряны: мы уже знаем о проблеме. Напишите нам, и мы всё решим: https://t.me/hanballit`
        : `Мы получили ваш платёж, но сумма меньше нужной (заказ ${body.order_id}). Так бывает из-за комиссии сети или курса. Доступ пока не открыт. Напишите нам, и мы вместе решим, как доплатить или вернуть деньги: https://t.me/hanballit`;
      await tg(env, "sendMessage", { chat_id: uid0, text: txt }).catch(() => {});
    }
    await notifyOwner(env, `<b>${PAY_WARN[status]}</b>\nСтатус: ${esc(status)}\n\n${details(await whoBlock(uid0))}${extra}`);
    return new Response("ok");
  }
  if (status !== "paid" && status !== "paid_over") return new Response("ok");   // other statuses: nothing to do
  const uid = uid0;
  if (!uid) {
    await notifyOwner(env, `<b>⚠️ Оплата без привязки к пользователю</b>\n\n${details(await whoBlock(0))}\n\nНужно разобраться вручную.`);
    return new Response("unknown order", { status: 200 });
  }
  // the payment notice must belong to the invoice we created for this order (same invoice id, not less than the amount we asked for)
  const mism = ordKV && env.PAY_BINDING !== "off" ? orderMismatch(ordKV, body) : "";
  if (mism) {
    if (!(await env.SUBS.get(`mm:${body.order_id}`))) {   // tell the owner once per order
      await env.SUBS.put(`mm:${body.order_id}`, "1", { expirationTtl: 86400 * 3 });
      await notifyOwner(env, `<b>⚠️ Данные платежа не совпали с заказом. Доступ не выдан</b>\nПричина: ${esc(mism)}\n\n${details(await whoBlock(uid))}\n\nЕсли оплата настоящая, выдайте доступ вручную: ${isCourse ? "/grantcourse " + uid + " " + ordKV.tier : "/grant " + uid}`);
    }
    return new Response("ok");
  }
  if (await isBanned(env, uid)) {   // a banned person is not given access: the owner decides about the money
    if (!(await env.SUBS.get(`bn:${body.order_id}`))) {
      await env.SUBS.put(`bn:${body.order_id}`, "1", { expirationTtl: 86400 * 3 });
      await notifyOwner(env, `<b>🚫 Оплата от исключённого пользователя. Доступ не выдан</b>\nНужен возврат денег, либо снимите бан (<code>/unban ${uid}</code>) и выдайте доступ вручную: <code>${isCourse ? "/grantcourse " + uid + " " + ordKV.tier : "/grant " + uid}</code>\n\n${details(await whoBlock(uid))}`);
    }
    return new Response("ok");
  }
  if (await env.SUBS.get(`rcpt:${body.order_id}`)) return new Response("ok");   // this order was already processed (also after a /revoke)
  const cur = await getPaid(env, uid);
  const curCourse = isCourse ? await getCourse(env, uid) : null;
  const recAmt = ordKV && ordKV.exp ? ordKV.exp.a : body.amount, recCur = ordKV && ordKV.exp ? ordKV.exp.c : body.currency;   // the record keeps the price of the order, always in its own currency
  const bonusOrder = "bonus:" + body.order_id;
  const courseDone = isCourse && hasOrder(curCourse, body.order_id), bonusDone = isCourse && hasOrder(cur, bonusOrder);
  if (isCourse ? (courseDone && bonusDone) : hasOrder(cur, body.order_id)) return new Response("ok");   // repeated notification
  const rcptVal = JSON.stringify({ uid, ts: Date.now(), status, amount: body.amount, currency: body.currency, usd: body.payment_amount_usd, payer: crypt, uuid: body.uuid, txid: body.txid || "" });
  await env.SUBS.put(`rcpt:${body.order_id}`, rcptVal, { expirationTtl: 86400 * 800 });   // claim before grant: stops sequential retries; KV is not atomic, so truly simultaneous deliveries are not blocked
  let rec, crec;
  try {
    if (isCourse) {
      // each step runs only if it is not done yet, so a retry after a half-finished grant completes the rest
      if (!courseDone) crec = await grantCourse(env, uid, ordKV.tier, { order: body.order_id, amount: recAmt, currency: recCur });
      rec = bonusDone ? cur : await grantAccess(env, uid, { order: bonusOrder, amount: "bonus", currency: "" });   // bonus: a month of the private channel
    } else rec = await grantAccess(env, uid, { order: body.order_id, amount: recAmt, currency: recCur });
  }
  catch (e) { await env.SUBS.delete(`rcpt:${body.order_id}`).catch(() => {}); throw e; }   // grant failed: release the claim so the provider's retry can succeed
  await notifyOwner(env, isCourse
    ? `🎓 <b>ОПЛАТА ОБУЧЕНИЯ${status === "paid_over" ? " (переплата)" : ""}</b>\n\n${details(await whoBlock(uid))}\n⏳ Бонус-приват до: ${fmtDate(rec.until)}`
    : `🛒 <b>НОВАЯ ОПЛАТА${status === "paid_over" ? " (переплата)" : ""}${cur ? " · продление" : ""}</b>\n\n${details(await whoBlock(uid))}\n⏳ Доступ до: ${fmtDate(rec.until)}`);
  try {
    const r = await tg(env, "sendMessage", {
      chat_id: uid,
      text: isCourse
        ? `Оплата обучения получена, спасибо! ✅\n\nТариф «${courseName}»: доступ навсегда. Подайте заявку в канал обучения кнопкой в приложении, раздел «Обучение». До ${fmtDate(CFG.COURSE_START)} заявка ждёт, в день старта мы одобрим её автоматически.\n\nБонус: доступ к привату до ${fmtDate(rec.until)} — заявка в закрытый канал в разделе «Приват».`
        : `Оплата получена, спасибо! ✅\n\nВаш доступ к привату открыт до ${fmtDate(rec.until)}.\nПодайте заявку в закрытый канал кнопкой в приложении, раздел «Приват». До 1 декабря заявка ждёт, в день старта мы одобрим её автоматически.`,
    });
    if (!r.ok) await dbg(env, { pay: "PAYER MSG FAILED " + (r.description || r.error_code), uid });
  } catch (e) { await dbg(env, { pay: "PAYER MSG ERROR " + String(e && e.message || e).slice(0, 60), uid }); }
  return new Response("ok");
}


// ---------- closed content (served only to opened-in-Telegram users) ----------
const SESSION_TTL = 24 * 3600;   // seconds
const b64u = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
// token signing key: SESSION_SECRET if set (separate from the Telegram webhook secret), otherwise WEBHOOK_SECRET as before
async function sessKey(env) { return enc.encode("sess:" + (env.SESSION_SECRET || env.WEBHOOK_SECRET)); }
async function makeToken(env, uid) {
  // stable within a day: the same token means the same image URLs, so the phone's cache is reused instead of reloading everything
  const exp = (Math.floor(Date.now() / 1000 / SESSION_TTL) + 2) * SESSION_TTL;   // valid for 24-48 hours
  const mac = b64u(await hmac(await sessKey(env), `${uid}.${exp}`));
  return `${uid}.${exp}.${mac}`;
}
async function checkToken(env, token) {
  const p = String(token || "").split(".");
  if (p.length !== 3 || !/^\d+$/.test(p[0]) || !/^\d+$/.test(p[1])) return false;
  if (Number(p[1]) < Date.now() / 1000) return false;
  const mac = b64u(await hmac(await sessKey(env), `${p[0]}.${p[1]}`));
  return safeEq(mac, p[2]);
}

const MIME = { json: "application/json; charset=utf-8", md: "text/plain; charset=utf-8", jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp", gif: "image/gif", svg: "image/svg+xml", mp4: "video/mp4" };

// one place that knows where the materials live: private GitHub repo if configured, otherwise the public site
async function fetchContent(env, path, etag) {
  if (env.CONTENT_REPO && env.GH_TOKEN) {
    return fetch(`https://api.github.com/repos/${env.CONTENT_REPO}/contents/${path.split("/").map(encodeURIComponent).join("/")}`, {
      headers: { authorization: `Bearer ${env.GH_TOKEN}`, accept: "application/vnd.github.raw+json", "user-agent": "p2p-study-bot", "x-github-api-version": "2022-11-28", ...(etag ? { "if-none-match": etag } : {}) },
    });
  }
  return fetch(CFG.APP_URL + path, { cf: { cacheTtl: 0 } });
}

async function handleContent(env, req, url) {
  const h = { "access-control-allow-origin": CFG.APP_ORIGIN, vary: "origin" };
  let path; try { path = decodeURIComponent(url.pathname.slice(3)); } catch { return new Response("bad path", { status: 400, headers: h }); }   // after "/c/"
  if (path === "bundle") return handleBundle(env, url, h);
  const tgm = path.match(/^ext\/tg\/(\w{8,64}\.(?:png|jpe?g|webp|gif))$/i);   // article images hosted on telegra.ph: fetched here once, then cached
  if (!tgm && (!/^content\/[\w\-./]+\.(?:md|json|jpe?g|png|webp|gif|svg|mp4)$/i.test(path) || path.includes(".."))) return new Response("bad path", { status: 400, headers: h });
  const tok = url.searchParams.get("t");
  if (!(await checkToken(env, tok)) || (await isBanned(env, String(tok).split(".")[0]))) return new Response("forbidden", { status: 403, headers: h });
  const ext = path.split(".").pop().toLowerCase();
  const isImg = /^(jpe?g|png|webp|gif|svg|mp4)$/.test(ext);
  const e = await getFile(env, path, tgm);
  if (e.status) return new Response("not found", { status: e.status, headers: h });
  const hd = { ...h, "content-type": e.type, etag: e.tag, "cache-control": isImg ? "private, max-age=86400" : "private, no-cache" };
  if (req.headers.get("if-none-match") === e.tag) return new Response(null, { status: 304, headers: hd });
  hd["accept-ranges"] = "bytes";
  const rg = ext === "mp4" && /^bytes=(\d*)-(\d*)$/.exec(req.headers.get("range") || "");   // iOS needs byte ranges to play video
  if (rg && req.method !== "HEAD") {
    const n = e.buf.byteLength; let a0 = rg[1] === "" ? Math.max(0, n - Number(rg[2])) : Number(rg[1]); let b0 = rg[1] === "" || rg[2] === "" ? n - 1 : Math.min(Number(rg[2]), n - 1);
    if (!(a0 <= b0 && a0 < n)) return new Response(null, { status: 416, headers: { ...hd, "content-range": "bytes */" + n } });
    return new Response(e.buf.slice(a0, b0 + 1), { status: 206, headers: { ...hd, "content-range": `bytes ${a0}-${b0}/${n}`, "content-length": String(b0 - a0 + 1) } });
  }
  return new Response(req.method === "HEAD" ? null : e.buf, { headers: hd });
}
// cached read of one file (memory cache in front of GitHub / telegra.ph)
async function getFile(env, path, tgm) {
  const ext = path.split(".").pop().toLowerCase();
  const isImg = /^(jpe?g|png|webp|gif|svg|mp4)$/.test(ext);
  const ttl = (isImg ? 3600 : 30) * 1000;
  const nf = NOTFOUND.get(path);
  if (nf && Date.now() - nf < 60000) return { status: 404 };   // missing files are remembered for a minute: no GitHub request per attempt
  let e = MEM.get(path);
  if (!e || Date.now() - e.t > ttl) {
    const up = tgm ? await fetch("https://telegra.ph/file/" + tgm[1], { headers: { "user-agent": "Mozilla/5.0" } }) : await fetchContent(env, path, e && e.upTag);
    if (up.status === 304 && e) { e.t = Date.now(); }   // GitHub: unchanged (a 304 does not count against the 5000/hour limit)
    else if (!up.ok) { if (e) { e.t = Date.now() - ttl + 15000; /* serve stale on upstream trouble, retry in 15 s */ } else { if (up.status === 404) { if (NOTFOUND.size > 500) NOTFOUND.clear(); NOTFOUND.set(path, Date.now()); return { status: 404 }; } return { status: 502 }; } }
    else {
      const buf = await up.arrayBuffer();
      e = { t: Date.now(), upTag: up.headers.get("etag") || "", buf, type: MIME[ext] || "application/octet-stream", tag: '"' + buf.byteLength + "-" + (await crypto.subtle.digest("SHA-1", buf).then((d) => hex(new Uint8Array(d)).slice(0, 12))) + '"' };
      if (buf.byteLength < 2 * 1024 * 1024) { if (MEM.has(path)) { MEM_BYTES -= MEM.get(path).buf.byteLength; MEM.delete(path); } MEM.set(path, e); MEM_BYTES += buf.byteLength; while ((MEM.size > 150 || MEM_BYTES > 40 * 1024 * 1024) && MEM.size) { const k0 = MEM.keys().next().value; MEM_BYTES -= MEM.get(k0).buf.byteLength; MEM.delete(k0); } }
    }
  }
  return e;
}
// one request for everything the app needs at start: materials.json + products.json + all article texts
async function handleBundle(env, url, h) {
  const tok = url.searchParams.get("t");
  if (!(await checkToken(env, tok)) || (await isBanned(env, String(tok).split(".")[0]))) return new Response("forbidden", { status: 403, headers: h });
  const dec = new TextDecoder();
  const [m, p] = await Promise.all([getFile(env, "content/materials.json"), getFile(env, "content/products.json")]);
  if (m.status || p.status) return new Response("upstream", { status: 502, headers: h });
  const mt = dec.decode(m.buf), pt = dec.decode(p.buf);
  let mm; try { mm = JSON.parse(mt); } catch { return new Response("bad materials", { status: 502, headers: h }); }
  const bodies = [...new Set((mm.sections || []).map((x) => x.body).filter((b) => typeof b === "string" && /^content\/[\w\-./]+\.md$/.test(b) && !b.includes("..")))].slice(0, 40);
  const files = await Promise.all(bodies.map((b) => getFile(env, b).catch(() => ({ status: 502 }))));
  const md = {}; bodies.forEach((b, i) => { md[b] = files[i].status ? "" : dec.decode(files[i].buf); });
  return new Response(JSON.stringify({ m: mt, p: pt, md }), { headers: { ...h, "content-type": "application/json; charset=utf-8", "cache-control": "private, no-store" } });
}
const MEM = new Map(), NOTFOUND = new Map();
let MEM_BYTES = 0;


// ---------- abuse protection (per-IP, best effort, in memory: costs no KV writes) ----------
const RL = new Map();
function limited(req, name, max, windowMs = 60000) {
  const ip = req.headers.get("cf-connecting-ip") || "unknown";
  const key = name + ":" + ip, now = Date.now();
  let e = RL.get(key);
  if (!e || now > e.t) { e = { t: now + windowMs, n: 0 }; RL.set(key, e); }
  e.n++;
  if (RL.size > 5000) for (const [k, v] of RL) if (now > v.t) RL.delete(k);
  return e.n > max;
}
const tooMany = (h = {}) => new Response(JSON.stringify({ ok: false, error: "too many requests" }), { status: 429, headers: { "content-type": "application/json", "retry-after": "60", ...h } });

// ---------- backup of paid users (sent to the owner as a JSON file) ----------
async function backupPaid(env, chatId) {
  const rows = []; let cursor;
  do {
    const l = await env.SUBS.list({ prefix: "paid:", cursor });
    for (const k of l.keys) rows.push({ id: k.name.slice(5), ...(k.metadata || {}) });
    cursor = l.list_complete ? undefined : l.cursor;
  } while (cursor);
  const day = new Date().toISOString().slice(0, 10);
  const fd = new FormData();
  fd.append("chat_id", String(chatId));
  fd.append("caption", `Резервная копия оплативших на ${day}: ${rows.length} чел.`);
  fd.append("document", new Blob([JSON.stringify({ date: day, paid: rows }, null, 1)], { type: "application/json" }), `paid-${day}.json`);
  const r = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/sendDocument`, { method: "POST", body: fd });
  return r.json();
}

// ---------- bot logic ----------
async function sendWelcome(env, chatId) {
  return tg(env, "sendMessage", {
    chat_id: chatId,
    text: CFG.WELCOME,
    reply_markup: {
      inline_keyboard: [
        [{ text: CFG.BTN_OPEN, web_app: { url: CFG.APP_URL } }],
        [{ text: CFG.BTN_CHANNEL, url: CFG.CHANNEL_URL }],
      ],
    },
  });
}

async function handleUpdate(env, ctx, upd) {
  if (upd.chat_join_request) { await handleJoinRequest(env, upd.chat_join_request); return; }
  if (upd.my_chat_member && upd.my_chat_member.chat.type === "channel" && upd.my_chat_member.new_chat_member.status === "administrator" && env.OWNER_ID && String(upd.my_chat_member.from && upd.my_chat_member.from.id) === String(env.OWNER_ID)) {   // tells the owner the channel id for PRIVATE_CHANNEL
    const c = upd.my_chat_member.chat;
    await tg(env, "sendMessage", { chat_id: env.OWNER_ID, parse_mode: "HTML", text: `Бот стал администратором канала «${esc(c.title || "")}».\nID канала: <code>${c.id}</code>${String(c.id) === String(env.PRIVATE_CHANNEL) ? "\nЭто закрытый канал из настроек ✅" : "\nЕсли это закрытый канал привата, впишите этот ID в переменную PRIVATE_CHANNEL. Если это канал обучения: COURSE_CH_ECO, COURSE_CH_STD или COURSE_CH_PRO."}` }).catch(() => {});
    return;
  }
  // user blocked / unblocked the bot
  if (upd.my_chat_member && upd.my_chat_member.chat.type === "private") {
    const st = upd.my_chat_member.new_chat_member.status;
    if (st === "kicked" || st === "left") await delSub(env, upd.my_chat_member.chat.id);
    return;
  }
  const m = upd.message;
  if (!m || !m.text) return;
  if (String(m.from && m.from.id) === String(env.OWNER_ID)) await dbg(env, { from: m.from.id, chat: m.chat.type, text: String(m.text).slice(0, 24) });   // not for everyone: KV writes are scarce (free plan)
  const chatId = m.chat.id;
  const text = m.text.trim();
  // owner commands only from the owner's own private chat: the group/chat id inside the update can never redirect replies or files elsewhere
  const isOwner = !!env.OWNER_ID && String(m.from.id) === String(env.OWNER_ID) && m.chat.type === "private" && String(m.chat.id) === String(m.from.id);

  if (m.chat.type === "private" && !/^\/start(\s|$)/.test(text)) await addSub(env, chatId, m.from);   // anyone who writes to the bot is a subscriber

  if (/^\/myid/.test(text)) {
    await tg(env, "sendMessage", { chat_id: chatId, text: `Ваш Telegram ID: ${m.from.id}` });
    return;
  }

  if (/^\/start(\s|$)/.test(text)) {
    try { await addSub(env, chatId, m.from); } catch (e) { console.log("addSub failed", e); }   // the welcome must go out even when the KV write quota is spent
    const w = await sendWelcome(env, chatId);
    if (!(w && w.ok)) await dbg(env, { welcome: "FAILED: " + (w && w.description) });
    return;
  }
  if (!isOwner) return;

  if (/^\/debug/.test(text)) {
    const wh = await tg(env, "getWebhookInfo");
    const me = await tg(env, "getMe");
    const log = JSON.parse((await env.SUBS.get("dbg")) || "[]");
    const r = wh.result || {};
    const lines = [
      `Бот: @${me.result && me.result.username}`,
      `Вебхук: ${r.url ? "задан" : "НЕ ЗАДАН"}, в очереди: ${r.pending_update_count}`,
      `Последняя ошибка доставки: ${r.last_error_message || "нет"}`,
      "",
      "Последние события:",
      ...log.map((e) => `${e.t} ` + (e.pay ? `оплата: ${e.pay} (${e.ip})` : e.welcome ? `приветствие: ${e.welcome}` : `от ${e.from} (${e.chat}): ${e.text}`)),
    ];
    await tg(env, "sendMessage", { chat_id: chatId, text: lines.join("\n") });
    return;
  }

  const ordc = text.match(/^\/order\s+(\S+)\s*$/);
  if (ordc) {
    const r = JSON.parse((await env.SUBS.get(`rcpt:${ordc[1]}`)) || "null");
    await tg(env, "sendMessage", { chat_id: chatId, text: r ? `Заказ ${ordc[1]}\nПользователь: ${r.uid}\nСумма: ${r.amount} ${r.currency || ""} (≈ ${r.usd || "?"} $)\nОплачено: ${r.payer || "—"}\nВремя: ${fmtDT(r.ts)}\nUUID: ${r.uuid}\nTXID: ${r.txid || "—"}` : "Заказ не найден." });
    return;
  }

  if (/^\/paid/.test(text)) {
    let n = 0, active = 0, cursor;
    do {
      const l = await env.SUBS.list({ prefix: "paid:", cursor });
      for (const k of l.keys) { n++; const un = k.metadata && k.metadata.until; if (un ? un > Date.now() : hasAccess(JSON.parse((await env.SUBS.get(k.name)) || "null"))) active++; }
      cursor = l.list_complete ? undefined : l.cursor;
    } while (cursor);
    await tg(env, "sendMessage", { chat_id: chatId, text: `Оплативших: ${n}, с действующим доступом: ${active}` });
    return;
  }

  const rev = text.match(/^\/revoke\s+(\d+)\s*$/);
  if (rev) {
    const r = await revokePrivat(env, rev[1]);
    await tg(env, "sendMessage", { chat_id: chatId, text: r.had ? `Оплата пользователя ${rev[1]} отозвана: доступ закрыт${r.removed ? ", из закрытого канала убран" : ""}.` : `У пользователя ${rev[1]} не было оплаты.` });
    return;
  }

  const gc = text.match(/^\/grantcourse\s+(\d+)\s+(eco|std|pro)\s*$/);
  if (gc) {
    const c = await grantCourse(env, Number(gc[1]), gc[2], { order: "manual-" + Date.now(), amount: "manual", currency: "" });
    await tg(env, "sendMessage", { chat_id: chatId, text: `Обучение выдано пользователю ${gc[1]}: тариф «${CFG.COURSE[c.tier].name}», навсегда. Бонус-приват выдавайте отдельно: /grant ${gc[1]}` });
    return;
  }
  const rc = text.match(/^\/revokecourse\s+(\d+)\s*$/);
  if (rc) {
    const r = await revokeCourse(env, rc[1]);
    await tg(env, "sendMessage", { chat_id: chatId, text: r.had ? `Обучение пользователя ${rc[1]} отозвано${r.kicked ? ", из каналов обучения убран" : ""}.` : `У пользователя ${rc[1]} не было обучения.` });
    return;
  }
  const gr = text.match(/^\/grant\s+(\d+)\s*$/);
  if (gr) {
    const rec = await grantAccess(env, Number(gr[1]), { order: "manual-" + Date.now(), amount: "manual", currency: "" });
    await tg(env, "sendMessage", { chat_id: chatId, text: `Доступ выдан пользователю ${gr[1]} до ${fmtDate(rec.until)}.` });
    return;
  }

  if (/^\/backup/.test(text)) {
    const r = await backupPaid(env, env.OWNER_ID);
    if (!r.ok) await tg(env, "sendMessage", { chat_id: chatId, text: "Не удалось отправить копию: " + (r.description || "ошибка") });
    return;
  }

  if (/^\/users/.test(text)) {
    const rows = []; let cursor;
    do {
      const l = await env.SUBS.list({ prefix: "u:", cursor });
      for (const k of l.keys) { const m2 = k.metadata || {}; rows.push([k.name.slice(2), m2.u ? "@" + m2.u : "", m2.n || "", m2.t ? new Date(m2.t).toISOString().slice(0, 10) : ""]); }
      cursor = l.list_complete ? undefined : l.cursor;
    } while (cursor);
    const paidIds = new Set(); cursor = undefined;
    do {
      const l = await env.SUBS.list({ prefix: "paid:", cursor });
      for (const k of l.keys) paidIds.add(k.name.slice(5));
      cursor = l.list_complete ? undefined : l.cursor;
    } while (cursor);
    const q = (x) => '"' + String(x).replace(/"/g, '""') + '"';
    const csv = "id,username,name,since,paid\n" + rows.map((r) => [r[0], q(r[1]), q(r[2]), r[3], paidIds.has(r[0]) ? "yes" : ""].join(",")).join("\n");
    const fd = new FormData();
    fd.append("chat_id", String(env.OWNER_ID));
    fd.append("caption", `Подписчиков бота: ${rows.length}, оплативших: ${paidIds.size}`);
    fd.append("document", new Blob([csv], { type: "text/csv" }), `users-${new Date().toISOString().slice(0, 10)}.csv`);
    await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/sendDocument`, { method: "POST", body: fd });
    return;
  }

  const t2328 = text.match(/^\/test2328(?:\s+(\w+))?\s*$/);
  if (t2328) {
    if (!(env.PAY2328_PROJECT && env.PAY2328_KEY)) { await tg(env, "sendMessage", { chat_id: chatId, text: "Ключи 2328 не заданы." }); return; }
    const st = t2328[1] || "paid";
    const r = await call2328(env, "/v1/test-webhook/payment", { url_callback: CFG.SELF + "/pay/webhook2328", currency: "USDT", network: "TRX-TRC20", status: st, order_id: "test-" + Date.now().toString(36) });
    await tg(env, "sendMessage", { chat_id: chatId, text: r.ok ? `Тест отправлен (статус ${st}). Результат придёт сообщением от бота оплат в течение минуты.` : `2328 вернул ошибку ${r.status}: ${JSON.stringify(r.j).slice(0, 300)}` });
    return;
  }

  const ban = text.match(/^\/(ban|unban)\s+(\d+)\s*$/);
  if (ban) {
    const id = ban[2];
    if (ban[1] === "ban") {
      await env.SUBS.put(`ban:${id}`, JSON.stringify({ ts: Date.now() }));
      await delSub(env, id);
      bannedCache.set(id, { v: true, t: Date.now() });
      const outP = privOn(env) ? (await kickFromPrivate(env, id)) === "removed" : false, outC = await kickFromCourseChannels(env, id);   // also taken out of the paid channels; payment records stay, so /unban restores everything
      await tg(env, "sendMessage", { chat_id: chatId, text: `Пользователь ${id} исключён: ему закрыт доступ к материалам, рассылки ему не уходят${outP || outC ? ", из закрытых каналов убран" : ""}. Вернуть: /unban ${id}` });
    } else {
      await env.SUBS.delete(`ban:${id}`);
      bannedCache.set(id, { v: false, t: Date.now() });
      await tg(env, "sendMessage", { chat_id: chatId, text: `Пользователь ${id} разблокирован. Он снова попадёт в список, когда напишет боту или откроет приложение.` });
    }
    return;
  }

  const who = text.match(/^\/who\s+(\d+)\s*$/);
  if (who) {
    const id = who[1];
    const sub = await env.SUBS.getWithMetadata(`u:${id}`);
    const paid = await getPaid(env, id);
    const banned = await env.SUBS.get(`ban:${id}`);
    const md = sub.metadata || {};
    await tg(env, "sendMessage", { chat_id: chatId, text: [
      `ID: ${id}`,
      `Подписчик: ${sub.value ? "да" : "нет"}${md.u ? ", @" + md.u : ""}${md.n ? ", " + md.n : ""}${md.t ? ", с " + new Date(md.t).toISOString().slice(0, 10) : ""}`,
      `Оплата: ${paid ? (hasAccess(paid) ? "активна до " + fmtDate(paid.until) : "истекла " + fmtDate(paid.until)) : "нет"}`,
      `Исключён: ${banned ? "да" : "нет"}`,
    ].join("\n") });
    return;
  }

  if (/^\/stats/.test(text)) {
    let n = 0, cursor;
    do {
      const l = await env.SUBS.list({ prefix: "u:", cursor });
      n += l.keys.length;
      cursor = l.list_complete ? undefined : l.cursor;
    } while (cursor);
    await tg(env, "sendMessage", { chat_id: chatId, text: `Подписчиков бота: ${n}` });
    return;
  }

  if (/^\/broadcast\s+/.test(text)) {
    const body = text.replace(/^\/broadcast\s+/, "");
    await startJob(env, ctx, { text: esc(body) }, chatId);
    return;
  }

  if (/^\/test\s+/.test(text)) {
    const body = text.replace(/^\/test\s+/, "");
    await tg(env, "sendMessage", { chat_id: chatId, text: esc(body), parse_mode: "HTML", disable_web_page_preview: true });
    return;
  }

  if (/^\/cancel/.test(text)) {
    if (!(await env.SUBS.get("job"))) { await tg(env, "sendMessage", { chat_id: chatId, text: "Сейчас нет идущей рассылки." }); return; }
    await env.SUBS.put("cancel", "1", { expirationTtl: 600 });
    await tg(env, "sendMessage", { chat_id: chatId, text: "Останавливаю рассылку: текущая порция дойдёт, следующие не пойдут." });
    return;
  }

  if (/^\/undo/.test(text)) {
    const raw = await env.SUBS.get("last");
    if (!raw) { await tg(env, "sendMessage", { chat_id: chatId, text: "Нечего отзывать: последней рассылки нет." }); return; }
    const last = JSON.parse(raw);
    if (Date.now() - last.ts > 47 * 3600 * 1000) {
      await env.SUBS.delete("last");
      await tg(env, "sendMessage", { chat_id: chatId, text: "С момента рассылки прошло больше 48 часов, Telegram не позволяет удалить такие сообщения." });
      return;
    }
    await env.SUBS.put("job", JSON.stringify({ mode: "undo", msgs: last.msgs, idx: 0, done: 0, failed: 0, ownerChat: chatId }));
    await tg(env, "sendMessage", { chat_id: chatId, text: `Удаляю последнюю рассылку у ${last.msgs.length} получателей. Пришлю итог.` });
    await continueJob(env, ctx);
    return;
  }

  const post = text.match(/^\/(post_test|post)(?:\s+(\S+))?\s*$/);
  if (post) {
    const testOnly = post[1] === "post_test";
    const list = await (await fetchContent(env, "content/materials.json")).json();
    const id = post[2] || (list.sections && list.sections[0] && list.sections[0].id);   // no id = the newest material (first in the list)
    const s = (list.sections || []).find((x) => x.id === id);
    if (!s) {
      await tg(env, "sendMessage", { chat_id: chatId, text: `Материал «${id}» не найден.` });
      return;
    }
    const payload = {
      text: `🆕 <b>Новый материал</b>\n\n<b>${esc(s.title)}</b>\n${esc(s.desc)}`,
      button: { text: "Читать", web_app: { url: `${CFG.APP_URL}?sec=${encodeURIComponent(id)}` } },
    };
    if (testOnly) {
      await tg(env, "sendMessage", { chat_id: chatId, text: payload.text, parse_mode: "HTML", disable_web_page_preview: true, reply_markup: { inline_keyboard: [[payload.button]] } });
      return;
    }
    await startJob(env, ctx, payload, chatId);
    return;
  }

  await tg(env, "sendMessage", {
    chat_id: chatId,
    text: "Команды владельца:\n/post — рассылка о самом новом материале (или /post <id> о конкретном)\n/broadcast <текст> — произвольная рассылка\n/test <текст> и /post_test — то же, но только вам (проверка)\n/undo — удалить последнюю рассылку у всех (до 48 часов)\n/cancel — остановить идущую рассылку\n/stats — число подписчиков\n/paid — сколько оплатили\n/order <номер заказа> — детали оплаты\n/backup — выгрузка списка оплативших файлом\n/users — список подписчиков файлом (CSV)\n/who <id> — сведения о пользователе\n/ban <id> — исключить, /unban <id> — вернуть\n/test2328 [статус] — тестовый webhook 2328 (проверка подписи, без оплаты)\n/grant <id> — выдать доступ к привату вручную\n/grantcourse <id> <eco|std|pro> — выдать обучение вручную\n/revokecourse <id> — отозвать обучение\n/revoke <id> — отозвать оплату",
  });
}

// ---------- broadcast (chunked so it works on the free plan) ----------
async function startJob(env, ctx, job, ownerChat) {
  if (await env.SUBS.get("job")) { await tg(env, "sendMessage", { chat_id: ownerChat, text: "Другая рассылка ещё идёт. Дождитесь итога и повторите." }); return; }
  await env.SUBS.put("job", JSON.stringify({ ...job, ownerChat, sent: 0, failed: 0, cursor: null, msgs: [] }));
  await tg(env, "sendMessage", { chat_id: ownerChat, text: "Рассылка запущена. Пришлю итог, когда закончу." });
  await continueJob(env, ctx);
}

async function continueJob(env, ctx) {
  const raw = await env.SUBS.get("job");
  if (!raw) return;
  const job = JSON.parse(raw);
  if (job.mode === "undo" && !(await env.SUBS.get("cancel"))) {
    const part = job.msgs.slice(job.idx, job.idx + CHUNK);
    for (const [chat, mid] of part) {
      const r = await tg(env, "deleteMessage", { chat_id: chat, message_id: mid });
      if (r.ok) job.done++; else job.failed++;
    }
    job.idx += part.length;
    if (job.idx >= job.msgs.length) {
      await env.SUBS.delete("job"); await env.SUBS.delete("last");
      await tg(env, "sendMessage", { chat_id: job.ownerChat, text: `Рассылка удалена. Удалено: ${job.done}, не удалось: ${job.failed}.` });
      return;
    }
    await env.SUBS.put("job", JSON.stringify(job));
    ctx.waitUntil(fetch(new URL("/continue", CFG.SELF).toString(), { method: "POST", headers: { "x-secret": env.WEBHOOK_SECRET } }).catch(() => {}));
    return;
  }
  if (await env.SUBS.get("cancel")) {   // /cancel from the owner: stop, keep what was sent so /undo still works
    await env.SUBS.delete("cancel"); await env.SUBS.delete("job");
    if (job.mode !== "undo") await env.SUBS.put("last", JSON.stringify({ ts: Date.now(), msgs: job.msgs }));
    await tg(env, "sendMessage", { chat_id: job.ownerChat, text: job.mode === "undo" ? `Удаление остановлено. Успели удалить: ${job.done || 0}.` : `Рассылка остановлена. Успели доставить: ${job.sent || 0}. Удалить их можно командой /undo.` });
    return;
  }
  const l = await env.SUBS.list({ prefix: "u:", limit: CHUNK, cursor: job.cursor || undefined });
  for (const k of l.keys) {
    const id = k.name.slice(2);
    const msg = { chat_id: id, text: job.text, parse_mode: "HTML", disable_web_page_preview: true };
    if (job.button) msg.reply_markup = { inline_keyboard: [[job.button]] };
    let r; try { r = await tg(env, "sendMessage", msg); } catch (e) { r = { ok: false, error_code: 0 }; }
    if (!r.ok && r.error_code === 429) {   // Telegram flood limit: wait as asked (up to 5 s) and try once more
      const ra = Math.min(5, Number(r.parameters && r.parameters.retry_after) || 1);
      await new Promise((res) => setTimeout(res, ra * 1000));
      try { r = await tg(env, "sendMessage", msg); } catch (e) { r = { ok: false, error_code: 0 }; }
    }
    if (r.ok) { job.sent++; job.msgs.push([id, r.result.message_id]); }
    else {
      job.failed++;
      if (r.error_code === 403) await delSub(env, id);
    }
  }
  if (l.list_complete || l.keys.length === 0) {
    await env.SUBS.delete("job");
    await env.SUBS.put("last", JSON.stringify({ ts: Date.now(), msgs: job.msgs }));
    await tg(env, "sendMessage", { chat_id: job.ownerChat, text: `Рассылка завершена. Доставлено: ${job.sent}, не доставлено: ${job.failed}.` });
    return;
  }
  job.cursor = l.cursor;
  await env.SUBS.put("job", JSON.stringify(job));
  // next chunk runs in a fresh invocation (fresh subrequest budget)
  ctx.waitUntil(fetch(new URL("/continue", CFG.SELF).toString(), {
    method: "POST",
    headers: { "x-secret": env.WEBHOOK_SECRET },
  }).catch(() => {}));
}

// ---------- HTTP entry ----------
const SEC_HEADERS = { "x-content-type-options": "nosniff", "referrer-policy": "no-referrer", "x-frame-options": "DENY", "permissions-policy": "geolocation=(), camera=(), microphone=()" };
async function withSecurityHeaders(res) {
  const out = new Response(res.body, res);
  for (const [k, v] of Object.entries(SEC_HEADERS)) out.headers.set(k, v);
  if (!out.headers.has("cache-control")) out.headers.set("cache-control", "no-store");
  return out;
}

const handlers = {
  async scheduled(event, env, ctx) {
    const nowD = new Date(Date.now());   // once a day, in the first run of the 06:00 UTC hour (the cron may run every few minutes)
    if (env.OWNER_ID && nowD.getUTCHours() === 6 && nowD.getUTCMinutes() < 10) ctx.waitUntil(backupPaid(env, env.OWNER_ID).catch((e) => console.log("backup error", e)));   // once a day even if the cron runs hourly
    ctx.waitUntil(privateSweep(env).catch(async (e) => { console.log("sweep error", e); await dbg(env, { sweep: "ERROR " + String(e && e.message || e).slice(0, 80) }); }));
  },
  async fetch(req, env, ctx) {
    if (!env.WEBHOOK_SECRET || !env.BOT_TOKEN) return new Response("not configured", { status: 503 });   // fail closed: tokens are signed with WEBHOOK_SECRET
    try { return withSecurityHeaders(await handlers.route(req, env, ctx)); }
    catch (e) { console.log("unhandled", e); return withSecurityHeaders(json({ ok: false, error: "server error" }, 500, cors(req.headers.get("origin")))); }
  },
  async route(req, env, ctx) {
    const url = new URL(req.url);
    CFG.SELF = url.origin;

    if (url.pathname === "/webhook" && req.method === "POST") {
      if (!safeEq(req.headers.get("x-telegram-bot-api-secret-token") || "", env.WEBHOOK_SECRET)) return new Response("forbidden", { status: 403 });
      const upd = await req.json();
      ctx.waitUntil(handleUpdate(env, ctx, upd).catch((e) => console.log("update error", e)));
      return new Response("ok");
    }

    if (url.pathname === "/continue" && req.method === "POST") {
      if (!safeEq(req.headers.get("x-secret") || "", env.WEBHOOK_SECRET)) return new Response("forbidden", { status: 403 });
      ctx.waitUntil(continueJob(env, ctx).catch(async (e) => { console.log("job error", e); await dbg(env, { job: "ERROR " + String(e && e.message || e).slice(0, 80) }); await notifyOwner(env, "<b>❗ Рассылка остановилась из-за ошибки</b>\nСмотрите /debug. Сообщения, уже отправленные в этом шаге, могут быть не записаны для /undo."); }));
      return new Response("ok");
    }

    if (url.pathname === "/api/check-sub") {
      const h = cors(req.headers.get("origin"));
      if (req.method !== "OPTIONS" && limited(req, "sub", 20)) return tooMany(h);
      if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: h });
      if (req.method !== "POST") return new Response("method", { status: 405, headers: h });
      let body;
      try { body = await req.json(); } catch { return json({ ok: false, error: "bad json" }, 400, h); }
      const user = await verifyInitData(body.initData, env.BOT_TOKEN);
      if (!user) return json({ ok: false, error: "bad initData" }, 401, h);
      let r; try { r = await tg(env, "getChatMember", { chat_id: CFG.CHANNEL, user_id: user.id }); } catch (e) { await dbg(env, { sub: "check-sub ERROR " + String(e && e.message || e).slice(0, 60) }); return json({ ok: false, error: "channel check failed" }, 502, h); }
      if (!r.ok) { await dbg(env, { sub: "check-sub " + (r.description || r.error_code) }); return json({ ok: false, error: "channel check failed (is the bot an admin of the channel?)" }, 502, h); }
      const subscribed = ["member", "administrator", "creator"].includes(r.result.status);
      if (subscribed) subCache.set(String(user.id), { v: "yes", t: Date.now() });   // keep /api/session consistent right after the user subscribes
      ctx.waitUntil(addSub(env, user.id, user).catch(() => {}));   // opening the app also registers the user (delivery only works once they have pressed Start; failures are cleaned up automatically)
      return json({ ok: true, subscribed }, 200, h);
    }



    if (url.pathname === "/api/session") {
      const h = cors(req.headers.get("origin"));
      if (req.method !== "OPTIONS" && limited(req, "sess", 20)) return tooMany(h);
      if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: h });
      if (req.method !== "POST") return new Response("method", { status: 405, headers: h });
      let body;
      try { body = await req.json(); } catch { return json({ ok: false, error: "bad json" }, 400, h); }
      const user = await verifyInitData(body.initData, env.BOT_TOKEN);
      if (!user) return json({ ok: false, error: "bad initData" }, 401, h);
      if (await isBanned(env, user.id)) return json({ ok: false, error: "banned" }, 403, h);
      const cs = await channelState(env, user.id);   // materials are for channel subscribers only
      if (cs === "no") return json({ ok: false, error: "not subscribed" }, 403, h);
      if (cs !== "yes") return json({ ok: false, error: "channel check failed" }, 502, h);
      return json({ ok: true, token: await makeToken(env, user.id), ttl: SESSION_TTL }, 200, h);
    }

    if (url.pathname.startsWith("/c/") && (req.method === "GET" || req.method === "HEAD")) { if (limited(req, "content", 600)) return tooMany(); return handleContent(env, req, url); }

    if (url.pathname === "/pay/webhook2328" && req.method === "POST") { if (limited(req, "hook", 120)) return tooMany(); return handlePay2328Webhook(env, req); }
    if (url.pathname === "/pay/webhook-cryptobot" && req.method === "POST") { if (limited(req, "hook", 120)) return tooMany(); return handleCryptoBotWebhook(env, req); }

    if (url.pathname === "/api/pay/create" || url.pathname === "/api/status") {
      const h = cors(req.headers.get("origin"));
      if (req.method !== "OPTIONS" && limited(req, url.pathname === "/api/status" ? "status" : "pay", url.pathname === "/api/status" ? 60 : 6)) return tooMany(h);
      if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: h });
      if (req.method !== "POST") return new Response("method", { status: 405, headers: h });
      let body;
      try { body = await req.json(); } catch { return json({ ok: false, error: "bad json" }, 400, h); }
      const user = await verifyInitData(body.initData, env.BOT_TOKEN);
      if (!user) return json({ ok: false, error: "bad initData" }, 401, h);
      if (await isBanned(env, user.id)) return json({ ok: false, error: "banned" }, 403, h);
      let paid = await getPaid(env, user.id);
      if (url.pathname === "/api/status") {
        const rk = "rc" + user.id, rNow = Date.now();
        let course = await getCourse(env, user.id);
        if ((!hasAccess(paid) || (body.product === "course" && !course)) && !(RECON.get(rk) > rNow - 15000)) { RECON.set(rk, rNow); if (RECON.size > 2000) RECON.clear(); try { await reconcile2328(env, user.id); paid = await getPaid(env, user.id); course = await getCourse(env, user.id); } catch (e) { await dbg(env, { reconcile: "2328 FAILED " + String(e && e.message || e).slice(0, 80) }); } }   // lost 2328/Crypto Bot webhook, orders from the last 24 h
        const cinfo = course && tierOf(course.tier) ? { tier: course.tier, name: CFG.COURSE[course.tier].name, join: env["COURSE_JOIN_" + course.tier.toUpperCase()] || undefined } : undefined;
        return json({ ok: true, paid: hasAccess(paid), until: paid ? paid.until : null, join: hasAccess(paid) && env.JOIN_URL ? env.JOIN_URL : undefined, course: cinfo }, 200, h);
      }
      RECON.delete("rc" + user.id);   // new invoice: the next status check may ask the provider right away
      const viaCB = body.method === "cryptobot";
      const prov = viaCB ? (env.CRYPTOBOT_TOKEN ? "cryptobot" : null) : payProvider(env);
      if (!prov) return json({ ok: false, error: "payments not configured" }, 503, h);
      const offer = offerFor(env, body);
      if (!offer) return json({ ok: false, error: "bad tier" }, 400, h);
      if (offer.product === "course") {
        const c = await getCourse(env, user.id);
        if (courseRank(c) >= CFG.COURSE[offer.tier].rank) return json({ ok: true, paid: true, course: { tier: c.tier } }, 200, h);   // this tier (or a higher one) is already bought
      } else if (hasAccess(paid) && paid.until - Date.now() > 10 * 86400000) return json({ ok: true, paid: true, until: paid.until }, 200, h);   // already paid, renewal opens 10 days before the end
      // an open invoice for the same thing is handed out again (no new invoice, no KV writes); at most 20 new invoices per user per day
      const lastOrder = await env.SUBS.get(`lastord:${user.id}`);
      const prevOrd = lastOrder ? JSON.parse((await env.SUBS.get(`ord:${lastOrder}`)) || "null") : null;
      const sameThing = prevOrd && (prevOrd.product || "privat") === offer.product && (offer.product !== "course" || prevOrd.tier === offer.tier) && prevOrd.p === prov;
      if (sameThing && prevOrd.url && Date.now() - prevOrd.ts < (CFG.PAY_LIFETIME - 120) * 1000 && !(await env.SUBS.get(`rcpt:${lastOrder}`))) return json({ ok: true, url: prevOrd.url, tg: !!prevOrd.tg }, 200, h);
      const madeToday = prevOrd && Date.now() - prevOrd.ts < 86400000 ? (prevOrd.n || 1) : 0;
      if (madeToday >= 20) return tooMany(h);
      offer.n = madeToday + 1;
      let inv = prov === "cryptobot" ? await createInvoiceCryptoBot(env, user, offer) : await createInvoice2328(env, user, offer);
      if (inv.error && prov !== "cryptobot" && env.CRYPTOBOT_TOKEN) {   // main provider down: fall back to Crypto Bot instead of a dead end
        await dbg(env, { pay: "FALLBACK to cryptobot: " + String(inv.error).slice(0, 60) });
        const fb = await createInvoiceCryptoBot(env, user, offer);
        if (!fb.error) inv = fb;
      }
      if (inv.error) { await dbg(env, { pay: "CREATE FAIL " + String(inv.error).slice(0, 60) }); return json({ ok: false, error: "invoice failed" }, 502, h); }
      return json({ ok: true, url: inv.url, tg: !!inv.tg }, 200, h);
    }

    // One-time setup: open  https://<worker>/setup?key=<WEBHOOK_SECRET>
    if (url.pathname === "/setup") {
      if (!safeEq(url.searchParams.get("key") || "", env.SETUP_KEY || env.WEBHOOK_SECRET)) return new Response("forbidden", { status: 403 });
      const a = await tg(env, "setWebhook", {
        url: url.origin + "/webhook",
        secret_token: env.WEBHOOK_SECRET,
        allowed_updates: ["message", "my_chat_member", "chat_join_request"],
      });
      const b = await tg(env, "setChatMenuButton", {
        menu_button: { type: "web_app", text: CFG.MENU_BUTTON_TEXT, web_app: { url: CFG.APP_URL } },
      });
      const c = await tg(env, "setMyCommands", { commands: [{ command: "start", description: "Открыть базу знаний" }] });
      return json({ webhook: a, menuButton: b, commands: c });
    }

    return new Response("P2P Study bot is running");
  },
};

export default { scheduled: handlers.scheduled, fetch: handlers.fetch };
