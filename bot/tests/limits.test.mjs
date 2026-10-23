// F-04: повторное использование открытого счёта и суточный лимит создания счетов.
import test, { beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkWorld, mkEnv, install, restore, createInvoice, freezeAt, unfreeze, realTime, cryptoBotHook, req, getJSON, nextIp } from "./harness.mjs";

let world, env;
beforeEach(() => { world = mkWorld(); install(world); env = mkEnv(); });
afterEach(restore);

test("F-04: 40 запросов одного тарифа с разных IP создают один счёт и почти не пишут в KV", async () => {
  const first = await createInvoice(env, 555, { product: "course", tier: "eco" });
  const w0 = env.SUBS.writes;
  for (let i = 0; i < 39; i++) { const r = await createInvoice(env, 555, { product: "course", tier: "eco" }); assert.equal(r.j.url, first.j.url); }
  assert.equal(world.invoices.length, 1);
  assert.equal(env.SUBS.writes, w0, "повторные запросы не должны писать в KV");
});

test("F-04: другой тариф или другой продукт — новый счёт", async () => {
  const a = await createInvoice(env, 555, { product: "course", tier: "eco" });
  const b = await createInvoice(env, 555, { product: "course", tier: "pro" });
  const c = await createInvoice(env, 555, {});
  assert.equal(world.invoices.length, 3);
  assert.equal(new Set([a.j.url, b.j.url, c.j.url]).size, 3);
});

test("F-04: счёт другого пользователя не выдаётся", async () => {
  const a = await createInvoice(env, 555, { product: "course", tier: "eco" });
  const b = await createInvoice(env, 556, { product: "course", tier: "eco" });
  assert.notEqual(a.j.url, b.j.url);
  assert.equal(world.invoices.length, 2);
});

test("F-04: по истечении срока жизни счёта создаётся новый", async () => {
  const t0 = realTime(); freezeAt(t0);
  const a = await createInvoice(env, 555, { product: "course", tier: "eco" });
  freezeAt(t0 + 3600 * 1000 + 1000);
  const b = await createInvoice(env, 555, { product: "course", tier: "eco" });
  unfreeze();
  assert.notEqual(a.j.url, b.j.url);
});

test("F-04: оплаченный счёт повторно не выдаётся (новая покупка того же приватa после оплаты)", async () => {
  const a = await createInvoice(env, 555, {});
  const inv = world.invoices[0];
  await req(env, "/pay/webhook-cryptobot", cryptoBotHook(inv.order, { invoiceId: inv.id, amount: "4990" }));
  assert.ok(await getJSON(env, "paid:555"));
  // доступ действует больше 10 дней: сервер отвечает «уже оплачено», а не старым счётом
  const b = await createInvoice(env, 555, {});
  assert.equal(b.j.paid, true);
  assert.equal(b.j.url, undefined);
  // старая запись продления: если оплата отозвана (/revoke), старый счёт не должен вернуться
  await env.SUBS.delete("paid:555");
  const c = await createInvoice(env, 555, {});
  assert.notEqual(c.j.url, a.j.url);
});

test("F-04: при исчерпании лимита ответ 429, а другой пользователь работает", async () => {
  // имитируем 20 созданных за сутки счетов записью предыдущего заказа
  const now = realTime();
  await env.SUBS.put("ord:u555-prev", JSON.stringify({ uid: 555, ts: now - 1000, n: 20, p: "cryptobot", url: "https://old", product: "course", tier: "eco" }));
  await env.SUBS.put("lastord:555", "u555-prev");
  const limited = await createInvoice(env, 555, { product: "course", tier: "pro" });
  assert.equal(limited.status, 429);
  const other = await createInvoice(env, 556, { product: "course", tier: "pro" });
  assert.equal(other.status, 200);
  // через сутки счётчик сбрасывается
  freezeAt(now + 25 * 3600 * 1000);
  const later = await createInvoice(env, 555, { product: "course", tier: "pro" });
  unfreeze();
  assert.equal(later.status, 200);
});

test("F-04: сверка статуса оплаты по последнему заказу продолжает работать", async () => {
  await createInvoice(env, 555, { product: "course", tier: "eco" });
  const order = await env.SUBS.get("lastord:555");
  assert.equal(order, world.invoices[0].order);
});
