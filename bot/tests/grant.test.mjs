// F-03 + F-09: выдача идемпотентна при одновременных событиях и доводится до конца после сбоя.
import test, { beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkWorld, mkEnv, install, restore, req, cryptoBotHook, getJSON, nextIp, daysFrom, OWNER } from "./harness.mjs";

let world;
beforeEach(() => { world = mkWorld(); install(world); });
afterEach(restore);
const hookAt = (env, order, opts) => req(env, "/pay/webhook-cryptobot", { ...cryptoBotHook(order, opts), ip: nextIp() });
const ownerMsgs = () => world.tg.filter((x) => x.method === "sendMessage" && String(x.b.chat_id) === OWNER).map((x) => x.b.text);

test("F-03: одновременная доставка одного вебхука не продлевает приват дважды (100 прогонов)", async () => {
  let doubled = 0;
  for (let i = 0; i < 100; i++) {
    const env = mkEnv({}, 6); const order = "u555-r" + i;
    await env.SUBS.put("ord:" + order, JSON.stringify({ uid: 555, p: "cryptobot" }));
    await Promise.all([hookAt(env, order, { amount: "4990" }), hookAt(env, order, { amount: "4990" }), hookAt(env, order, { amount: "4990" })]);
    const p = await getJSON(env, "paid:555");
    if (daysFrom(p.until) > 31 || p.orders.length !== 1) doubled++;
  }
  assert.equal(doubled, 0, "двойное продление в " + doubled + " из 100");
});

test("F-03: курс — одновременная доставка не удваивает бонус-приват (100 прогонов)", async () => {
  let doubled = 0;
  for (let i = 0; i < 100; i++) {
    const env = mkEnv({}, 6); const order = "u555-c" + i;
    await env.SUBS.put("ord:" + order, JSON.stringify({ uid: 555, p: "cryptobot", product: "course", tier: "std" }));
    await Promise.all([hookAt(env, order, { amount: "24990" }), hookAt(env, order, { amount: "24990" })]);
    const p = await getJSON(env, "paid:555"), c = await getJSON(env, "course:555");
    if (daysFrom(p.until) > 31 || p.orders.length !== 1 || c.orders.length !== 1) doubled++;
  }
  assert.equal(doubled, 0);
});

test("F-03 (негативный): два разных заказа подряд продлевают дважды", async () => {
  const env = mkEnv();
  for (const o of ["u555-a", "u555-b"]) { await env.SUBS.put("ord:" + o, JSON.stringify({ uid: 555, p: "cryptobot" })); await hookAt(env, o, { amount: "4990" }); }
  assert.equal(daysFrom((await getJSON(env, "paid:555")).until), 62);
});

test("F-03: два разных платежа одновременно не теряют месяц", async () => {
  const env = mkEnv({}, 6);
  for (const o of ["u555-a", "u555-b"]) await env.SUBS.put("ord:" + o, JSON.stringify({ uid: 555, p: "cryptobot" }));
  await Promise.all([hookAt(env, "u555-a", { amount: "4990" }), hookAt(env, "u555-b", { amount: "4990", invoiceId: 8 })]);
  const p = await getJSON(env, "paid:555");
  assert.equal(p.orders.length, 2, "один из заказов потерян");
  assert.equal(daysFrom(p.until), 62);
});

test("F-09: сбой на бонусе — повторный вебхук доводит выдачу до конца, уведомление одно", async () => {
  const env = mkEnv(); const order = "u556-x";
  await env.SUBS.put("ord:" + order, JSON.stringify({ uid: 556, p: "cryptobot", product: "course", tier: "pro" }));
  env.SUBS.failPut = (k) => k === "paid:556";
  assert.equal((await hookAt(env, order, { amount: "44990" })).status, 500);
  assert.ok(await getJSON(env, "course:556"));
  assert.equal(await env.SUBS.get("paid:556"), null);
  env.SUBS.failPut = null;
  assert.equal((await hookAt(env, order, { amount: "44990" })).status, 200);
  const p = await getJSON(env, "paid:556");
  assert.ok(p, "бонус-приват не выдан после повтора");
  assert.deepEqual(p.orders, ["bonus:" + order]);
  assert.equal((await getJSON(env, "course:556")).orders.length, 1);
  assert.equal(ownerMsgs().filter((t) => t.includes("ОПЛАТА ОБУЧЕНИЯ")).length, 1);
  await hookAt(env, order, { amount: "44990" });
  assert.equal(ownerMsgs().filter((t) => t.includes("ОПЛАТА ОБУЧЕНИЯ")).length, 1, "лишнее уведомление");
  assert.equal(daysFrom((await getJSON(env, "paid:556")).until), 31);
});

test("F-09: без сбоев курс и бонус выдаются один раз", async () => {
  const env = mkEnv(); const order = "u557-x";
  await env.SUBS.put("ord:" + order, JSON.stringify({ uid: 557, p: "cryptobot", product: "course", tier: "eco" }));
  await hookAt(env, order, { amount: "9990" }); await hookAt(env, order, { amount: "9990" });
  assert.equal((await getJSON(env, "paid:557")).orders.length, 1);
  assert.equal(ownerMsgs().filter((t) => t.includes("ОПЛАТА ОБУЧЕНИЯ")).length, 1);
});
