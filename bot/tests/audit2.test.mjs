// Дополнительные находки внешней проверки: F-02 (KV при неверной подписи), N-04, N-05, N-02, N-08, BL-19, BL-22.
import test, { beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkWorld, mkEnv, install, restore, req, hook2328, cryptoBotHook, ownerSay, scheduled, freezeAt, getJSON, initData, user, OWNER, SECRET } from "./harness.mjs";

let world;
beforeEach(() => { world = mkWorld(); install(world); });
afterEach(restore);
const DEC20 = Date.UTC(2026, 11, 20, 12, 30), CH = "-1001";
const paidRec = (env, uid) => env.SUBS.put("paid:" + uid, JSON.stringify({ until: Date.UTC(2027, 0, 15), orders: ["o"] }), { metadata: { until: Date.UTC(2027, 0, 15) } });

test("F-02: неверные подписи вебхуков не пишут в KV", async () => {
  const env = mkEnv({ PAY2328_KEY: "key-2328-test", PAY2328_PROJECT: "p" });
  const w0 = env.SUBS.writes;
  for (let i = 0; i < 40; i++) {
    await req(env, "/pay/webhook2328", { body: '{"order_id":"x","payment_status":"paid","sign":"aa"}' });
    await req(env, "/pay/webhook-cryptobot", { body: cryptoBotHook("x").body, headers: { "crypto-pay-api-signature": "00" } });
  }
  assert.equal(env.SUBS.writes, w0, "KV писался на неподписанные запросы");
});

test("N-04: заявка не пропадает, если Telegram ответил отказом по лимиту; после восстановления одобряется", async () => {
  freezeAt(DEC20);
  const env = mkEnv({ PRIVATE_CHANNEL: CH });
  await env.SUBS.put("jr:800", "1"); await paidRec(env, 800);
  world.tgFail = (m) => m === "approveChatJoinRequest";
  await scheduled(env);
  assert.ok(await env.SUBS.get("jr:800"), "заявка удалена при сбое");
  world.tgFail = null;
  await scheduled(env);
  assert.ok(world.tg.some((x) => x.method === "approveChatJoinRequest" && x.b.user_id === 800));
  assert.equal(await env.SUBS.get("jr:800"), null);
});

test("N-04: то же для заявок в канал курса", async () => {
  freezeAt(Date.UTC(2027, 0, 20));
  const env = mkEnv({ PRIVATE_CHANNEL: CH, COURSE_CH_ECO: "-2001" });
  await env.SUBS.put("jrc:801:eco", "1"); await env.SUBS.put("course:801", JSON.stringify({ tier: "eco", orders: ["o"] }));
  world.tgFail = (m) => m === "approveChatJoinRequest";
  await scheduled(env);
  assert.ok(await env.SUBS.get("jrc:801:eco"), "заявка курса удалена при сбое");
  world.tgFail = null; await scheduled(env);
  assert.equal(await env.SUBS.get("jrc:801:eco"), null);
});

test("N-04: заявка, которую Telegram больше не знает, не копится вечно (12 неудач подряд)", async () => {
  freezeAt(DEC20);
  const env = mkEnv({ PRIVATE_CHANNEL: CH });
  await env.SUBS.put("jr:802", "1"); await paidRec(env, 802);
  world.tgFail = (m) => m === "approveChatJoinRequest";
  for (let i = 0; i < 12; i++) await scheduled(env);
  assert.equal(await env.SUBS.get("jr:802"), null);
});

test("N-02: листинг каталога и пути без допустимого расширения закрыты", async () => {
  const env = mkEnv();
  const r0 = await req(env, "/api/session", { body: { initData: initData(user(5)) } });
  const t = (await r0.json()).token;
  for (const p of ["content/articles", "content/articles/", "content", "content/x.php", "content/.git/config", "content/a..b"]) {
    const r = await req(env, "/c/" + p + "?t=" + encodeURIComponent(t), { method: "GET" });
    assert.equal(r.status, 400, p);
  }
});

test("N-02: повторные запросы несуществующего файла не ходят в GitHub каждый раз", async () => {
  const env = mkEnv({ CONTENT_REPO: "o/r", GH_TOKEN: "x" });
  let gh = 0; const f = world.fetch;
  globalThis.fetch = async (u, o) => { if (String(u).includes("api.github.com")) { gh++; return new Response("nf", { status: 404 }); } return f(u, o); };
  const t = (await (await req(env, "/api/session", { body: { initData: initData(user(6)) } })).json()).token;
  for (let i = 0; i < 10; i++) await req(env, "/c/content/nothing-here.md?t=" + encodeURIComponent(t), { method: "GET" });
  assert.equal(gh, 1);
});

test("N-08: добавление бота админом чужим человеком не шлёт владельцу сообщение", async () => {
  const env = mkEnv();
  const upd = (from) => ({ update_id: 3, my_chat_member: { chat: { id: -999, type: "channel", title: "X" }, from: { id: from }, new_chat_member: { status: "administrator" } } });
  const hdr = { "x-telegram-bot-api-secret-token": SECRET };
  await req(env, "/webhook", { body: upd(555), headers: hdr });
  assert.equal(world.tg.filter((x) => x.method === "sendMessage").length, 0);
  await req(env, "/webhook", { body: upd(Number(OWNER)), headers: hdr });
  assert.equal(world.tg.filter((x) => x.method === "sendMessage" && String(x.b.chat_id) === OWNER).length, 1);
});

test("BL-19: оплата забаненного не выдаёт доступ, владелец получает пометку о возврате, один раз", async () => {
  const env = mkEnv({ PAY2328_KEY: "key-2328-test", PAY2328_PROJECT: "p" });
  await env.SUBS.put("ban:22", "1");
  await env.SUBS.put("ord:u22-a", JSON.stringify({ uid: 22, p: "2328" }));
  const pay = () => req(env, "/pay/webhook2328", hook2328({ order_id: "u22-a", uuid: "u-1", payment_status: "paid", amount: "4990", currency: "RUB" }));
  await pay(); await pay();
  assert.equal(await env.SUBS.get("paid:22"), null, "доступ выдан забаненному");
  const m = world.tg.filter((x) => x.method === "sendMessage" && String(x.b.chat_id) === OWNER).map((x) => x.b.text);
  assert.equal(m.filter((t) => t.includes("возврат")).length, 1);
  // после разбана повторное уведомление/опрос выдаёт доступ
  await ownerSay(env, "/unban 22"); await pay();
  assert.ok(await getJSON(env, "paid:22"));
});

test("BL-22: в записи оплаты цена заказа в своей валюте, а не смесь с долларами", async () => {
  const env = mkEnv({ PAY2328_KEY: "key-2328-test", PAY2328_PROJECT: "p" });
  await env.SUBS.put("ord:u30-a", JSON.stringify({ uid: 30, p: "2328", exp: { a: "4990", c: "RUB" } }));
  await req(env, "/pay/webhook2328", hook2328({ order_id: "u30-a", uuid: "u-1", payment_status: "paid", amount: "4990", currency: "RUB", payment_amount_usd: "61.5" }));
  const rec = await getJSON(env, "paid:30");
  assert.equal(rec.amount, "4990"); assert.equal(rec.currency, "RUB");
});

// ---- второй проход внешней проверки
test("BL-08: одновременная оплата VIP и «Базовый» всегда оставляет VIP и оба заказа (200 прогонов)", async () => {
  let bad = 0;
  for (let i = 0; i < 200; i++) {
    const env = mkEnv({ PAY2328_KEY: "key-2328-test", PAY2328_PROJECT: "p" }, 6);
    await env.SUBS.put("ord:u40-a", JSON.stringify({ uid: 40, p: "2328", product: "course", tier: "pro", exp: { a: "44990", c: "RUB" } }));
    await env.SUBS.put("ord:u40-b", JSON.stringify({ uid: 40, p: "2328", product: "course", tier: "eco", exp: { a: "9990", c: "RUB" } }));
    const h = (o, a) => req(env, "/pay/webhook2328", hook2328({ order_id: o, uuid: "u-" + o, payment_status: "paid", amount: a, currency: "RUB" }));
    await Promise.all(i % 2 ? [h("u40-a", "44990"), h("u40-b", "9990")] : [h("u40-b", "9990"), h("u40-a", "44990")]);
    const c = await getJSON(env, "course:40");
    if (!c || c.tier !== "pro" || !c.orders.includes("u40-a") || !c.orders.includes("u40-b")) bad++;
  }
  assert.equal(bad, 0, "ошибочных итогов: " + bad);
});

test("N-02b: // отклоняется, а варианты с ./ и %2e сводятся к одному пути и делят один кэш 404", async () => {
  const env = mkEnv({ CONTENT_REPO: "o/r", GH_TOKEN: "x" });
  let gh = 0; const f = world.fetch;
  globalThis.fetch = async (u, o) => { if (String(u).includes("api.github.com")) { gh++; return new Response("nf", { status: 404 }); } return f(u, o); };
  const t = (await (await req(env, "/api/session", { body: { initData: initData(user(7)) } })).json()).token;
  const get = (p) => req(env, "/c/" + p + "?t=" + encodeURIComponent(t), { method: "GET" });
  assert.equal((await get("content//articles/x.md")).status, 400);
  for (const p of ["content/articles/x.md", "content/./articles/x.md", "content/a/../articles/x.md", "content/%2e/articles/x.md", "content/a/%2e%2e/articles/x.md"]) await get(p);
  assert.equal(gh, 1, "обращений к GitHub: " + gh);
});

test("бюджет: худший случай (12 заявок курса, 12 заявок привата, 8 просроченных) укладывается в 50 вызовов с запасом", async () => {
  freezeAt(Date.UTC(2027, 0, 20));
  const env = mkEnv({ PRIVATE_CHANNEL: CH, COURSE_CH_ECO: "-2001", SWEEP_JOIN_BATCH: "12", SWEEP_KICK_BATCH: "8" });
  for (let i = 0; i < 12; i++) { await env.SUBS.put("jrc:" + (500 + i) + ":eco", "1"); await env.SUBS.put("course:" + (500 + i), JSON.stringify({ tier: "eco", orders: ["o"] })); }
  for (let i = 0; i < 12; i++) { await env.SUBS.put("jr:" + (600 + i), "1"); await paidRec(env, 600 + i); }
  for (let i = 0; i < 8; i++) { await env.SUBS.put("paid:" + (700 + i), JSON.stringify({ until: Date.UTC(2027, 0, 10), orders: ["o"] }), { metadata: { until: Date.UTC(2027, 0, 10) } }); world.members.add(CH + ":" + (700 + i)); }
  const c0 = env.SUBS.ops + world.tg.length;
  await scheduled(env);
  const used = env.SUBS.ops + world.tg.length - c0;
  assert.ok(used <= 46, "вызовов: " + used);
});
