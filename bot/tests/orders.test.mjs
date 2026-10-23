// F-01 + F-10: уникальный номер заказа, привязка оплаты к конкретному счёту, строгая проверка тарифа.
import test, { beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkWorld, mkEnv, install, restore, req, cryptoBotHook, hook2328, createInvoice, getJSON, freezeAt, unfreeze, realTime, OWNER } from "./harness.mjs";

let world, env;
beforeEach(() => { world = mkWorld(); install(world); env = mkEnv({ PAY2328_KEY: "key-2328-test", PAY2328_PROJECT: "p" }, 3); });
afterEach(restore);
const ownerMsgs = () => world.tg.filter((x) => x.method === "sendMessage" && String(x.b.chat_id) === OWNER).map((x) => x.b.text);

test("F-01: два параллельных счёта при замороженном времени получают разные номера", async () => {
  freezeAt(realTime());
  const [a, b] = await Promise.all([createInvoice(env, 555, { product: "course", tier: "eco" }), createInvoice(env, 555, { product: "course", tier: "pro" })]);
  unfreeze();
  assert.equal(a.status, 200); assert.equal(b.status, 200);
  const orders = world.invoices.map((i) => i.order);
  assert.equal(orders.length, 2);
  assert.notEqual(orders[0], orders[1], "номера заказов совпали");
  for (const o of orders) assert.match(o, /^u555-[a-z0-9]{8,}$/);
});

test("F-01: оплата дешёвого счёта не выдаёт дорогой тариф", async () => {
  freezeAt(realTime());
  await Promise.all([createInvoice(env, 555, { product: "course", tier: "eco" }), createInvoice(env, 555, { product: "course", tier: "pro" })]);
  unfreeze();
  const cheap = world.invoices.find((i) => i.amount === "9990");
  const r = await req(env, "/pay/webhook-cryptobot", cryptoBotHook(cheap.order, { invoiceId: cheap.id, amount: cheap.amount }));
  assert.equal(r.status, 200);
  assert.equal((await getJSON(env, "course:555")).tier, "eco");
});

test("F-01: вебхук с чужим номером счёта (uuid) не выдаёт доступ и уведомляет владельца", async () => {
  await createInvoice(env, 555, { product: "course", tier: "pro" });
  const inv = world.invoices[0];
  const r = await req(env, "/pay/webhook-cryptobot", cryptoBotHook(inv.order, { invoiceId: inv.id + 999, amount: "44990" }));
  assert.equal(r.status, 200);
  assert.equal(await env.SUBS.get("course:555"), null);
  assert.ok(ownerMsgs().some((t) => t.includes("не совпал")), "владелец должен получить предупреждение");
});

test("F-01: недоплата в той же валюте не выдаёт тариф", async () => {
  await createInvoice(env, 555, { product: "course", tier: "pro" });
  const inv = world.invoices[0];
  await req(env, "/pay/webhook-cryptobot", cryptoBotHook(inv.order, { invoiceId: inv.id, amount: "1", fiat: "RUB" }));
  assert.equal(await env.SUBS.get("course:555"), null);
  assert.ok(ownerMsgs().some((t) => t.includes("не совпал")));
});

test("F-01: корректная оплата выдаёт тариф и бонус", async () => {
  await createInvoice(env, 555, { product: "course", tier: "std" });
  const inv = world.invoices[0];
  await req(env, "/pay/webhook-cryptobot", cryptoBotHook(inv.order, { invoiceId: inv.id, amount: "24990" }));
  assert.equal((await getJSON(env, "course:555")).tier, "std");
  assert.ok(await getJSON(env, "paid:555"));
});

test("F-01: заказы старого формата без uuid и ожидаемой суммы по-прежнему обрабатываются", async () => {
  await env.SUBS.put("ord:u555-legacy", JSON.stringify({ uid: 555, p: "cryptobot", product: "course", tier: "eco" }));
  const r = await req(env, "/pay/webhook-cryptobot", cryptoBotHook("u555-legacy", { amount: "9990" }));
  assert.equal(r.status, 200);
  assert.equal((await getJSON(env, "course:555")).tier, "eco");
});

test("F-01: 2328 — вебхук с чужим uuid не выдаёт доступ", async () => {
  const e = mkEnv({ PAY2328_KEY: "key-2328-test", PAY2328_PROJECT: "p", CRYPTOBOT_TOKEN: undefined, PAY_PROVIDER: "2328" });
  const r0 = await req(e, "/api/pay/create", { body: { initData: (await import("./harness.mjs")).initData((await import("./harness.mjs")).user(556)), product: "course", tier: "eco" } });
  assert.equal(r0.status, 200);
  const inv = world.invoices.at(-1);
  const bad = hook2328({ order_id: inv.order, uuid: "uuid-foreign", payment_status: "paid", amount: "9990", currency: "RUB" });
  assert.equal((await req(e, "/pay/webhook2328", bad)).status, 200);
  assert.equal(await e.SUBS.get("course:556"), null);
  const ok = hook2328({ order_id: inv.order, uuid: inv.id, payment_status: "paid", amount: "9990", currency: "RUB" });
  await req(e, "/pay/webhook2328", ok);
  assert.equal((await getJSON(e, "course:556")).tier, "eco");
});

test("F-10: имена из прототипа вместо тарифа дают 400", async () => {
  for (const tier of ["__proto__", "constructor", "toString", "hasOwnProperty", "valueOf"]) {
    const r = await createInvoice(env, 555, { product: "course", tier });
    assert.equal(r.status, 400, tier);
  }
  assert.equal(world.invoices.length, 0);
});

test("F-10: неизвестный тариф и тариф без продукта отклоняются, приват работает", async () => {
  assert.equal((await createInvoice(env, 555, { product: "course", tier: "gold" })).status, 400);
  assert.equal((await createInvoice(env, 555, { product: "course" })).status, 400);
  assert.equal((await createInvoice(env, 555, {})).status, 200);
});
