// P2P Study bot — Cloudflare Worker.
// Does: /start welcome, subscriber list, channel-subscription check for the mini app,
// owner-only broadcasts (/post <id>, /broadcast <text>, /stats).
//
// Secrets (Cloudflare dashboard → Worker → Settings → Variables and Secrets):
//   BOT_TOKEN       token from BotFather            (Secret)
//   WEBHOOK_SECRET  any long random string           (Secret)
//   OWNER_ID        your numeric Telegram user id    (Variable)
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
  if (hex(await hmac(secret, dcs)) !== hash) return null;
  const age = Date.now() / 1000 - Number(p.get("auth_date") || 0);
  if (!(age >= 0 && age <= maxAgeSec)) return null;
  try { return JSON.parse(p.get("user")); } catch { return null; }
}

async function tg(env, method, body) {
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
  vary: "origin",
});
const json = (obj, status = 200, extra = {}) =>
  new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", ...extra } });

// ---------- subscribers ----------
const addSub = (env, id) => env.SUBS.put(`u:${id}`, JSON.stringify({ ts: Date.now() }));
const delSub = (env, id) => env.SUBS.delete(`u:${id}`);

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
  // user blocked / unblocked the bot
  if (upd.my_chat_member && upd.my_chat_member.chat.type === "private") {
    const st = upd.my_chat_member.new_chat_member.status;
    if (st === "kicked" || st === "left") await delSub(env, upd.my_chat_member.chat.id);
    return;
  }
  const m = upd.message;
  if (!m || !m.text) return;
  const chatId = m.chat.id;
  const text = m.text.trim();
  const isOwner = String(m.from.id) === String(env.OWNER_ID);

  if (/^\/myid/.test(text)) {
    await tg(env, "sendMessage", { chat_id: chatId, text: `Ваш Telegram ID: ${m.from.id}` });
    return;
  }

  if (/^\/start(\s|$)/.test(text)) {
    await addSub(env, chatId);
    await sendWelcome(env, chatId);
    return;
  }
  if (!isOwner) return;

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

  const post = text.match(/^\/post\s+(\S+)/);
  if (post) {
    const id = post[1];
    const list = await (await fetch(CFG.APP_URL + "content/materials.json", { cf: { cacheTtl: 0 } })).json();
    const s = (list.sections || []).find((x) => x.id === id);
    if (!s) {
      await tg(env, "sendMessage", { chat_id: chatId, text: `Материал «${id}» не найден.` });
      return;
    }
    await startJob(env, ctx, {
      text: `🆕 <b>Новый материал</b>\n\n<b>${esc(s.title)}</b>\n${esc(s.desc)}`,
      button: { text: "Читать", url: `https://t.me/${CFG.BOT_USERNAME}?startapp=${id}` },
    }, chatId);
    return;
  }

  await tg(env, "sendMessage", {
    chat_id: chatId,
    text: "Команды владельца:\n/post <id материала> — рассылка о новом материале\n/broadcast <текст> — произвольная рассылка\n/stats — число подписчиков",
  });
}

// ---------- broadcast (chunked so it works on the free plan) ----------
async function startJob(env, ctx, job, ownerChat) {
  await env.SUBS.put("job", JSON.stringify({ ...job, ownerChat, sent: 0, failed: 0, cursor: null }));
  await tg(env, "sendMessage", { chat_id: ownerChat, text: "Рассылка запущена. Пришлю итог, когда закончу." });
  await continueJob(env, ctx);
}

async function continueJob(env, ctx) {
  const raw = await env.SUBS.get("job");
  if (!raw) return;
  const job = JSON.parse(raw);
  const l = await env.SUBS.list({ prefix: "u:", limit: CHUNK, cursor: job.cursor || undefined });
  for (const k of l.keys) {
    const id = k.name.slice(2);
    const msg = { chat_id: id, text: job.text, parse_mode: "HTML", disable_web_page_preview: true };
    if (job.button) msg.reply_markup = { inline_keyboard: [[job.button]] };
    const r = await tg(env, "sendMessage", msg);
    if (r.ok) job.sent++;
    else {
      job.failed++;
      if (r.error_code === 403) await delSub(env, id);
    }
  }
  if (l.list_complete || l.keys.length === 0) {
    await env.SUBS.delete("job");
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
export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    CFG.SELF = url.origin;

    if (url.pathname === "/webhook" && req.method === "POST") {
      if (req.headers.get("x-telegram-bot-api-secret-token") !== env.WEBHOOK_SECRET) return new Response("forbidden", { status: 403 });
      const upd = await req.json();
      ctx.waitUntil(handleUpdate(env, ctx, upd).catch((e) => console.log("update error", e)));
      return new Response("ok");
    }

    if (url.pathname === "/continue" && req.method === "POST") {
      if (req.headers.get("x-secret") !== env.WEBHOOK_SECRET) return new Response("forbidden", { status: 403 });
      ctx.waitUntil(continueJob(env, ctx).catch((e) => console.log("job error", e)));
      return new Response("ok");
    }

    if (url.pathname === "/api/check-sub") {
      const h = cors(req.headers.get("origin"));
      if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: h });
      if (req.method !== "POST") return new Response("method", { status: 405, headers: h });
      let body;
      try { body = await req.json(); } catch { return json({ ok: false, error: "bad json" }, 400, h); }
      const user = await verifyInitData(body.initData, env.BOT_TOKEN);
      if (!user) return json({ ok: false, error: "bad initData" }, 401, h);
      const r = await tg(env, "getChatMember", { chat_id: CFG.CHANNEL, user_id: user.id });
      if (!r.ok) return json({ ok: false, error: "channel check failed (is the bot an admin of the channel?)" }, 502, h);
      const subscribed = ["member", "administrator", "creator"].includes(r.result.status);
      return json({ ok: true, subscribed }, 200, h);
    }

    // One-time setup: open  https://<worker>/setup?key=<WEBHOOK_SECRET>
    if (url.pathname === "/setup") {
      if (url.searchParams.get("key") !== env.WEBHOOK_SECRET) return new Response("forbidden", { status: 403 });
      const a = await tg(env, "setWebhook", {
        url: url.origin + "/webhook",
        secret_token: env.WEBHOOK_SECRET,
        allowed_updates: ["message", "my_chat_member"],
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
