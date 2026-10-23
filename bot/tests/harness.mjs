// Тестовый каркас: воркер запускается в Node с имитацией KV, Telegram и платёжных провайдеров.
// Никаких настоящих ключей и сетевых запросов: все значения вымышленные.
import crypto from "node:crypto";
import W from "../worker.js";

export const BOT = "123456:TEST_TOKEN_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
export const SECRET = "test-webhook-secret-0123456789";
export const CB_TOKEN = "cb-test-token";
export const K2328 = "key-2328-test";
export const OWNER = "999";
export const APP_ORIGIN = "https://abcabsu-cyber.github.io";
export const PRIVAT_START = Date.UTC(2026, 11, 1);

// ---------- KV ----------
export function mkKV(jitterMs = 0) {
  const m = new Map();
  const sl = () => (jitterMs ? new Promise((r) => setTimeout(r, Math.random() * jitterMs)) : Promise.resolve());
  const kv = {
    _m: m, writes: 0, ops: 0, failPut: null,
    async get(k) { kv.ops++; await sl(); return m.has(k) ? m.get(k).v : null; },
    async getWithMetadata(k) { kv.ops++; await sl(); const e = m.get(k); return { value: e ? e.v : null, metadata: e ? e.md : null }; },
    async put(k, v, o) { kv.ops++; await sl(); if (kv.failPut && kv.failPut(k)) throw new Error("KV put failed"); kv.writes++; m.set(k, { v: String(v), md: o && o.metadata }); },
    async delete(k) { kv.ops++; m.delete(k); },
    async list(o = {}) { kv.ops++;
      let keys = [...m.keys()].filter((k) => k.startsWith(o.prefix || "")).sort();
      const start = o.cursor ? Number(o.cursor) : 0;
      const lim = o.limit || 1000;
      const page = keys.slice(start, start + lim);
      const more = start + lim < keys.length;
      return { keys: page.map((name) => ({ name, metadata: m.get(name).md })), list_complete: !more, cursor: more ? String(start + lim) : undefined };
    },
  };
  return kv;
}

// ---------- мир: Telegram и провайдеры ----------
export function mkWorld() {
  const w = {
    tg: [],                    // все вызовы Telegram
    docs: [],                  // отправленные документы
    invoices: [],              // созданные счета (любой провайдер)
    members: new Set(),        // «<chat_id>:<user_id>» участников закрытых каналов
    tgFail: null,              // функция (method)=>true, чтобы имитировать сбой Telegram
    seq: 100,
  };
  w.fetch = async (url, opts = {}) => {
    url = String(url);
    if (url.includes("api.telegram.org")) {
      const method = url.split("/").pop();
      if (opts.body instanceof FormData) { w.docs.push({ method, chat: opts.body.get("chat_id"), name: opts.body.get("document") && opts.body.get("document").name }); return json({ ok: true, result: {} }); }
      const b = opts.body ? JSON.parse(opts.body) : {};
      w.tg.push({ method, b });
      if (w.tgFail && w.tgFail(method, b)) return new Response("upstream error", { status: 502 });
      if (method === "getChatMember") return json({ ok: true, result: { status: b.chat_id === "@hanballit_arbitrage" || w.members.has(b.chat_id + ":" + b.user_id) ? "member" : "left" } });
      if (method === "banChatMember") { w.members.delete(b.chat_id + ":" + b.user_id); return json({ ok: true, result: true }); }
      return json({ ok: true, result: { message_id: 1 } });
    }
    if (url.includes("pay.crypt.bot")) {
      const b = JSON.parse(opts.body || "{}");
      const id = ++w.seq; w.invoices.push({ p: "cryptobot", id, amount: b.amount, cur: b.fiat, order: b.payload });
      return json({ ok: true, result: { invoice_id: id, bot_invoice_url: "https://t.me/CryptoBot?start=inv" + id } });
    }
    if (url.includes("api.2328.io")) {
      const b = JSON.parse(opts.body || "{}");
      if (url.endsWith("/v1/payment")) { const id = "uuid-" + (++w.seq); w.invoices.push({ p: "2328", id, amount: b.amount, cur: b.currency, order: b.order_id }); return json({ state: 0, result: { url: "https://pay.2328.io/" + id, uuid: id } }); }
      return json({ state: 1 });
    }
    return new Response("not found", { status: 404 });
  };
  return w;
}
const json = (o) => new Response(JSON.stringify(o), { headers: { "content-type": "application/json" } });

// ---------- окружение воркера ----------
export function mkEnv(over = {}, jitter = 0) {
  return { BOT_TOKEN: BOT, WEBHOOK_SECRET: SECRET, OWNER_ID: OWNER, CRYPTOBOT_TOKEN: CB_TOKEN, SUBS: mkKV(jitter), ...over };
}

// ---------- запросы ----------
export const ctx = { p: [], waitUntil(pr) { ctx.p.push(pr); } };
export const settle = async () => { while (ctx.p.length) await Promise.all(ctx.p.splice(0)); };
let ipn = 0;
export const nextIp = () => `10.${(ipn >> 16) & 255}.${(ipn >> 8) & 255}.${ipn++ & 255}`;
export function req(env, path, { method = "POST", body, headers = {}, ip } = {}) {
  const r = new Request("https://w.test" + path, {
    method, body: typeof body === "string" ? body : body ? JSON.stringify(body) : undefined,
    headers: { origin: APP_ORIGIN, "cf-connecting-ip": ip || nextIp(), ...headers },
  });
  return W.fetch(r, env, ctx);
}
export const scheduled = async (env) => { await W.scheduled({}, env, ctx); await settle(); };

// ---------- подписи ----------
const hm = (k, d) => crypto.createHmac("sha256", k).update(d).digest();
export function initData(user, { token = BOT, ageSec = 0 } = {}) {
  const p = new URLSearchParams({ auth_date: String(Math.floor(Date.now() / 1000) - ageSec), user: JSON.stringify(user), query_id: "q" });
  const dcs = [...p.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([k, v]) => `${k}=${v}`).join("\n");
  p.set("hash", hm(hm("WebAppData", token), dcs).toString("hex"));
  return p.toString();
}
export const user = (id) => ({ id, first_name: "T" + id, username: "u" + id });

export function cryptoBotHook(order, { invoiceId = 7, amount = "9990", fiat = "RUB", status = "paid", date } = {}) {
  const raw = JSON.stringify({ update_type: "invoice_paid", request_date: date || new Date().toISOString(), payload: { status, payload: order, invoice_id: invoiceId, amount, fiat, paid_amount: "100", paid_asset: "USDT" } });
  const sig = crypto.createHmac("sha256", crypto.createHash("sha256").update(CB_TOKEN).digest()).update(raw).digest("hex");
  return { body: raw, headers: { "crypto-pay-api-signature": sig } };
}
export function hook2328(fields, key = K2328) {
  const raw = JSON.stringify(fields);
  const sign = crypto.createHmac("sha256", key).update(Buffer.from(raw).toString("base64")).digest("hex");
  return { body: raw.slice(0, -1) + ',"sign":"' + sign + '"}' };
}

// ---------- удобные действия ----------
export async function createInvoice(env, uid, extra = {}, ip) {
  const r = await req(env, "/api/pay/create", { body: { initData: initData(user(uid)), method: "cryptobot", ...extra }, ip });
  return { status: r.status, j: await r.json().catch(() => ({})) };
}
export async function status(env, uid, extra = {}) {
  const r = await req(env, "/api/status", { body: { initData: initData(user(uid)), ...extra } });
  return { status: r.status, j: await r.json().catch(() => ({})) };
}
export async function ownerSay(env, text, { chat = Number(OWNER), from = Number(OWNER), chatType = "private", secret = SECRET } = {}) {
  const r = await req(env, "/webhook", { body: { update_id: 1, message: { message_id: 1, text, from: { id: from, first_name: "O" }, chat: { id: chat, type: chatType } } }, headers: { "x-telegram-bot-api-secret-token": secret } });
  await settle(); return r;
}
export async function joinRequest(env, uid, chatId) {
  await req(env, "/webhook", { body: { update_id: 2, chat_join_request: { chat: { id: Number(chatId), type: "channel" }, from: { id: uid }, user_chat_id: uid, date: 1 } }, headers: { "x-telegram-bot-api-secret-token": SECRET } });
  await settle();
}
export const getJSON = async (env, k) => { const v = await env.SUBS.get(k); return v ? JSON.parse(v) : null; };

// ---------- время и сеть ----------
const realNow = Date.now, realFetch = globalThis.fetch;
export function install(world) { globalThis.fetch = world.fetch; }
export function restore() { Date.now = realNow; globalThis.fetch = realFetch; }
export function freezeAt(ms) { Date.now = () => ms; }
export const unfreeze = () => { Date.now = realNow; };
export const realTime = () => realNow();
export const daysFrom = (until, from = Math.max(realNow(), PRIVAT_START)) => Math.round((until - from) / 86400000);
