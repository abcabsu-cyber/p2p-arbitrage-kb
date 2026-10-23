// Базовая защита: то, что уже работает и не должно сломаться при исправлениях.
import test, { beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkWorld, mkEnv, install, restore, req, initData, user, cryptoBotHook, hook2328, ownerSay, createInvoice, getJSON, SECRET, OWNER, APP_ORIGIN, nextIp } from "./harness.mjs";

let world, env;
beforeEach(() => { world = mkWorld(); install(world); env = mkEnv({ PAY2328_KEY: "key-2328-test", PAY2328_PROJECT: "p" }); });
afterEach(restore);

test("initData: чужой бот, просрочка, подмена id -> 401", async () => {
  for (const ini of [initData(user(1), { token: "999:OTHER" }), initData(user(1), { ageSec: 90000 }), initData(user(1)).replace("%22id%22%3A1", "%22id%22%3A2")]) {
    const r = await req(env, "/api/status", { body: { initData: ini } });
    assert.equal(r.status, 401);
  }
  assert.equal((await req(env, "/api/status", { body: { initData: initData(user(1)) } })).status, 200);
});

test("вебхуки провайдеров: неверная и пустая подпись отклоняются", async () => {
  let r = await req(env, "/pay/webhook-cryptobot", { body: cryptoBotHook("u1-x").body, headers: { "crypto-pay-api-signature": "00" } });
  assert.equal(r.status, 401);
  r = await req(env, "/pay/webhook-cryptobot", { body: cryptoBotHook("u1-x").body });
  assert.equal(r.status, 401);
  r = await req(env, "/pay/webhook2328", { body: '{"order_id":"u1-x","payment_status":"paid","sign":"aa"}' });
  assert.equal(r.status, 401);
  r = await req(mkEnv({}), "/pay/webhook", { body: '{"order_id":"u1-x","status":"paid","sign":"aa"}' });
  assert.notEqual(r.status, 200);
});

test("/webhook и служебные маршруты закрыты без секрета", async () => {
  assert.equal((await req(env, "/webhook", { body: "{}" })).status, 403);
  assert.equal((await req(env, "/webhook", { body: "{}", headers: { "x-telegram-bot-api-secret-token": "undefined" } })).status, 403);
  assert.equal((await req(env, "/continue", { headers: { "x-secret": "x" } })).status, 403);
  assert.equal((await req(env, "/setup?key=wrong", { method: "GET" })).status, 403);
});

test("без WEBHOOK_SECRET воркер закрыт (503)", async () => {
  const e = mkEnv(); delete e.WEBHOOK_SECRET;
  assert.equal((await req(e, "/webhook", { body: "{}", headers: { "x-telegram-bot-api-secret-token": "undefined" } })).status, 503);
});

test("материалы: токен обязателен, подделка и обход путей отклоняются", async () => {
  const t = (await (await req(env, "/api/session", { body: { initData: initData(user(555)) } })).json()).token;
  assert.ok(t);
  assert.equal((await req(env, "/c/content/materials.json", { method: "GET" })).status, 403);
  const [u, e, m] = t.split(".");
  for (const bad of [t.replace(/.$/, "A"), `556.${e}.${m}`, `${u}.${Number(e) + 9999999}.${m}`]) assert.equal((await req(env, "/c/content/materials.json?t=" + bad, { method: "GET" })).status, 403);
  for (const p of ["/c/content/../bot/worker.js", "/c/content/%2e%2e/bot/worker.js", "/c/..%2f..%2fetc/passwd", "/c/etc/passwd", "/c/content/a%00.json", "/c/ext/tg/..%2f..%2fx.png"]) {
    const r = await req(env, p + "?t=" + t, { method: "GET" });
    assert.ok([400, 403, 404].includes(r.status), p + " -> " + r.status);
  }
});

test("забаненный не получает токен материалов", async () => {
  await env.SUBS.put("ban:777", "1");
  assert.equal((await req(env, "/api/session", { body: { initData: initData(user(777)) } })).status, 403);
});

test("CORS: чужой origin не получает разрешения", async () => {
  const r = await req(env, "/api/status", { body: { initData: initData(user(1)) }, headers: { origin: "https://evil.example" } });
  assert.equal(r.headers.get("access-control-allow-origin"), APP_ORIGIN);
});

test("команды владельца недоступны другим пользователям", async () => {
  await ownerSay(env, "/grant 555", { from: 555, chat: 555 });
  await ownerSay(env, "/grantcourse 555 pro", { from: 555, chat: 555 });
  assert.equal(await env.SUBS.get("paid:555"), null);
  assert.equal(await env.SUBS.get("course:555"), null);
});

test("клиент не может задать сумму или статус: цена берётся с сервера", async () => {
  const r = await createInvoice(env, 555, { product: "course", tier: "eco", amount: "1", currency: "USD", status: "paid" });
  assert.equal(r.status, 200);
  assert.equal(world.invoices.at(-1).amount, "9990");
  assert.equal(world.invoices.at(-1).cur, "RUB");
});

test("устаревший вебхук CryptoBot отклоняется", async () => {
  await env.SUBS.put("ord:u1-old", JSON.stringify({ uid: 1, p: "cryptobot" }));
  const h = cryptoBotHook("u1-old", { date: "2020-01-01T00:00:00Z" });
  assert.equal((await req(env, "/pay/webhook-cryptobot", h)).status, 400);
  assert.equal(await env.SUBS.get("paid:1"), null);
});

test("повторный вебхук по очереди не продлевает доступ", async () => {
  await env.SUBS.put("ord:u1-seq", JSON.stringify({ uid: 1, p: "cryptobot" }));
  for (let i = 0; i < 3; i++) await req(env, "/pay/webhook-cryptobot", cryptoBotHook("u1-seq", { amount: "4990" }));
  assert.equal((await getJSON(env, "paid:1")).orders.length, 1);
});
